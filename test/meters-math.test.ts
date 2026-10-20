/**
 * Unit tests for the plugin's pure modules (`src/meters-math.ts`,
 * `src/config.ts`). No test framework dependency: Node's built-in runner.
 *
 * Run from the package root:  npm test
 * (equivalently `node --test test/meters-math.test.ts` — Node ≥ 22 strips
 * the TypeScript types natively.)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_METERS_CONFIG,
  resolveMetersConfig,
} from '../src/config.ts'
import {
  DB_FLOOR,
  PALETTE_STOPS,
  WaterfallBuffer,
  aggregateBands,
  buildPaletteLut,
  byteToSample,
  computePeak,
  computeRms,
  createVuState,
  dbToFraction,
  levelToDb,
  logBandEdges,
  lutColor,
  stepVu,
} from '../src/meters-math.ts'

const approx = (actual: number, expected: number, epsilon = 1e-6) =>
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} ≈ ${expected} (±${epsilon})`,
  )

test('byteToSample maps the byte range onto [-1, 1)', () => {
  assert.equal(byteToSample(128), 0)
  assert.equal(byteToSample(0), -1)
  approx(byteToSample(255), 127 / 128)
  approx(byteToSample(192), 0.5)
})

test('computeRms / computePeak follow the AnalyserNode byte conventions', () => {
  const silence = new Uint8Array(256).fill(128)
  assert.equal(computeRms(silence), 0)
  assert.equal(computePeak(silence), 0)

  const dc = new Uint8Array(256).fill(192) // constant +0.5 sample
  approx(computeRms(dc), 0.5)
  approx(computePeak(dc), 0.5)

  const square = new Uint8Array(256)
  for (let i = 0; i < square.length; i++) square[i] = i % 2 === 0 ? 255 : 0
  approx(computeRms(square), Math.sqrt((1 + (127 / 128) ** 2) / 2), 1e-3)
  approx(computePeak(square), 1)

  assert.equal(computeRms(new Uint8Array(0)), 0)
  assert.equal(computePeak(new Uint8Array(0)), 0)
})

test('levelToDb / dbToFraction are clamped inverses on the meter scale', () => {
  assert.equal(levelToDb(1), 0)
  approx(levelToDb(0.5), -6.0206, 1e-3)
  assert.equal(levelToDb(0), DB_FLOOR)
  assert.equal(levelToDb(0.0001), DB_FLOOR) // -80 dB is below the floor
  assert.equal(levelToDb(2), 0) // over-range clamps to 0 dB

  assert.equal(dbToFraction(DB_FLOOR), 0)
  assert.equal(dbToFraction(0), 1)
  approx(dbToFraction(-30), 0.5)
  assert.equal(dbToFraction(-120), 0)
})

test('stepVu: instant attack, rate-limited release', () => {
  let state = createVuState()
  state = stepVu(state, -20, -20)
  assert.equal(state.levelDb, -20) // attack is instant

  state = stepVu(state, -40, -40)
  approx(state.levelDb, -20.9) // falls by releaseDbPerFrame (0.9), not to -40

  state = stepVu(state, -15, -15)
  assert.equal(state.levelDb, -15) // input above the current level attacks instantly again

  // Release never undershoots the current RMS.
  let falling = createVuState()
  falling = stepVu(falling, -59.7, -59.7)
  falling = stepVu(falling, -59.7, -59.7)
  assert.equal(falling.levelDb, -59.7)
})

test('stepVu: peak holds, then falls slowly, never below the frame peak', () => {
  let state = createVuState()
  state = stepVu(state, -10, -3)
  assert.equal(state.peakDb, -3)
  assert.equal(state.peakHoldFramesLeft, 45)

  // During the hold the marker does not move even for silent frames.
  for (let i = 0; i < 45; i++) state = stepVu(state, DB_FLOOR, DB_FLOOR)
  assert.equal(state.peakDb, -3)
  assert.equal(state.peakHoldFramesLeft, 0)

  // After the hold it falls by peakFallDbPerFrame (0.35).
  state = stepVu(state, DB_FLOOR, DB_FLOOR)
  approx(state.peakDb, -3.35)

  // …and the fall stops at the current frame peak instead of passing it:
  // from -3.35 it descends 0.35/frame and settles exactly on -5.
  state = stepVu(state, -5, -5)
  approx(state.peakDb, -3.7)
  for (let i = 0; i < 10; i++) state = stepVu(state, -5, -5)
  assert.equal(state.peakDb, -5)

  // Silence long enough returns everything to the floor, never below.
  for (let i = 0; i < 400; i++) state = stepVu(state, DB_FLOOR, DB_FLOOR)
  assert.equal(state.levelDb, DB_FLOOR)
  assert.equal(state.peakDb, DB_FLOOR)
})

test('logBandEdges are contiguous, non-empty, and widen with frequency', () => {
  const edges = logBandEdges(64, 16)
  assert.equal(edges.length, 16)
  assert.equal(edges[0]![0], 1) // bin 0 (DC) is excluded
  assert.equal(edges[edges.length - 1]![1], 64)
  for (let i = 0; i < edges.length; i++) {
    const [start, end] = edges[i]!
    assert.ok(end > start, `band ${i} is non-empty`)
    if (i > 0) assert.equal(start, edges[i - 1]![1], `band ${i} is contiguous`)
  }
  const widths = edges.map(([s, e]) => e - s)
  assert.ok(widths[widths.length - 1]! > widths[0]!, 'high bands are wider than low bands')

  // Asking for more bands than bins degrades to one bin per band.
  const saturated = logBandEdges(8, 100)
  assert.equal(saturated.length, 7)
})

test('aggregateBands takes the per-band maximum, normalised to 0..1', () => {
  const freq = new Uint8Array([0, 10, 200, 30, 255, 0, 0, 90])
  const bands = aggregateBands(freq, [
    [1, 3],
    [3, 5],
    [5, 8],
  ])
  assert.equal(bands.length, 3)
  approx(bands[0]!, 200 / 255)
  approx(bands[1]!, 1)
  approx(bands[2]!, 90 / 255)
})

test('WaterfallBuffer is a newest-first ring of frames', () => {
  const waterfall = new WaterfallBuffer(3, 2)
  assert.equal(waterfall.size, 0)
  assert.equal(waterfall.columnAtAge(0), undefined)

  waterfall.push([1, 2])
  waterfall.push([3, 4])
  assert.equal(waterfall.size, 2)
  assert.deepEqual([...waterfall.columnAtAge(0)!], [3, 4])
  assert.deepEqual([...waterfall.columnAtAge(1)!], [1, 2])
  assert.equal(waterfall.columnAtAge(2), undefined)

  // Ring wraps: after width more pushes the oldest frame is gone.
  waterfall.push([5, 6])
  waterfall.push([7, 8])
  assert.equal(waterfall.size, 3)
  assert.deepEqual([...waterfall.columnAtAge(0)!], [7, 8])
  assert.deepEqual([...waterfall.columnAtAge(2)!], [3, 4])

  // Short frames are zero-padded to the buffer height.
  const padded = new WaterfallBuffer(2, 3)
  padded.push([9])
  assert.deepEqual([...padded.columnAtAge(0)!], [9, 0, 0])

  waterfall.clear()
  assert.equal(waterfall.size, 0)
  assert.equal(waterfall.columnAtAge(0), undefined)
})

test('buildPaletteLut interpolates the stops across 256 entries', () => {
  const ember = buildPaletteLut(PALETTE_STOPS.ember!)
  assert.deepEqual(lutColor(ember, 0), [0, 0, 0])
  assert.deepEqual(lutColor(ember, 255), [255, 224, 64])
  // One third along the 4-stop ramp lands on the purple stop.
  assert.deepEqual(lutColor(ember, 85), [64, 0, 128])

  const mono = buildPaletteLut(PALETTE_STOPS.mono!)
  const mid = lutColor(mono, 128)
  assert.ok(mid[0] === mid[1] && mid[1] === mid[2], 'mono stays grey')
  assert.ok(mid[0] > 100 && mid[0] < 160, 'mono midpoint is mid-grey')
})

test('resolveMetersConfig validates per-field with default fallbacks', () => {
  assert.deepEqual(resolveMetersConfig(undefined), DEFAULT_METERS_CONFIG)
  assert.deepEqual(resolveMetersConfig(null), DEFAULT_METERS_CONFIG)
  assert.deepEqual(resolveMetersConfig('vu'), DEFAULT_METERS_CONFIG)
  assert.deepEqual(resolveMetersConfig({ mode: 'vu', palette: 'ice' }), {
    mode: 'vu',
    palette: 'ice',
  })
  assert.deepEqual(resolveMetersConfig({ mode: 'loud', palette: 'ice' }), {
    mode: 'spectrum',
    palette: 'ice',
  })
  assert.deepEqual(resolveMetersConfig({ mode: 'spectrogram', extra: true }), {
    mode: 'spectrogram',
    palette: 'ember',
  })
  // The result is a fresh object, never the shared defaults.
  assert.notEqual(resolveMetersConfig(undefined), DEFAULT_METERS_CONFIG)
})
