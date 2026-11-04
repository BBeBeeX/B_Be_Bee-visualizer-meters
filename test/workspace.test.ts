/**
 * Unit tests for the workspace layout model (`src/workspace.ts`) and
 * the audio-frame adapter (`src/audio-frame.ts`). No DOM, no React:
 * plain `node --test`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addPanel,
  bringToFront,
  clampPanel,
  createMemoryWorkspaceStorage,
  createStoreWorkspaceStorage,
  defaultWorkspace,
  movePanel,
  parseWorkspace,
  removePanel,
  resizePanel,
  setPanelZoom,
  snapToGrid,
  studioDashboardWorkspace,
  validateWorkspace,
  WORKSPACE_PRESETS,
} from '../src/workspace.ts'
import {
  createVisualizerFrameSource,
  TimeHistory,
} from '../src/audio-frame.ts'
import {
  aggregateOctaveBands,
  buildPaletteLut,
  byteToDb,
  computeStereoLevels,
  createLoudnessState,
  loudnessFromRms,
  lutColor,
  octaveBandEdges,
  PALETTE_STOPS,
  resampleToLogRows,
  stepLoudness,
} from '../src/meters-math.ts'

test('snapToGrid rounds to the 20px grid', () => {
  assert.equal(snapToGrid(0), 0)
  assert.equal(snapToGrid(29), 20)
  assert.equal(snapToGrid(31), 40)
  assert.equal(snapToGrid(-5), 0)
})

test('movePanel snaps when snap is on, not when off, and brings to front', () => {
  const base = defaultWorkspace()
  const first = base.panels[0]!
  const snapped = movePanel(base, first.id, 33, 47)
  const moved = snapped.panels[snapped.panels.length - 1]!
  assert.equal(moved.id, first.id)
  assert.equal(moved.x, 40)
  assert.equal(moved.y, 40)

  const free = movePanel({ ...base, snap: false }, first.id, 33, 47)
  const freeMoved = free.panels[free.panels.length - 1]!
  assert.equal(freeMoved.x, 33)
  assert.equal(freeMoved.y, 47)
})

test('resizePanel clamps to the panel minimums', () => {
  const base = defaultWorkspace()
  const first = base.panels[0]!
  const resized = resizePanel(base, first.id, 10, 10)
  const panel = resized.panels.find((p) => p.id === first.id)!
  assert.ok(panel.w >= 220 && panel.h >= 150)
})

test('add/remove/bringToFront compose without mutating the input', () => {
  const base = defaultWorkspace()
  const added = addPanel(base, 'xy-scope')
  assert.equal(added.panels.length, base.panels.length + 1)
  assert.equal(base.panels.length, 10, 'studio preset carries all ten meters')
  const id = added.panels[added.panels.length - 1]!.id
  const front = bringToFront(added, added.panels[0]!.id)
  assert.equal(front.panels[front.panels.length - 1]!.id, added.panels[0]!.id)
  const removed = removePanel(front, id)
  assert.equal(removed.panels.length, base.panels.length)
  assert.equal(base.panels.length, 10, 'input workspace is untouched')
})

test('setPanelZoom clamps to 0.5..4', () => {
  const base = defaultWorkspace()
  const first = base.panels[0]!
  assert.equal(first.zoom, undefined)
  const zoomed = setPanelZoom(base, first.id, 99)
  const panel = zoomed.panels.find((p) => p.id === first.id)!
  assert.equal(panel.zoom, 4)
})

test('validateWorkspace drops unknown kinds and bad numbers, keeps the rest', () => {
  const parsed = validateWorkspace({
    name: 'Mine',
    palette: 'ice',
    snap: false,
    panels: [
      { id: 'a', kind: 'fft-analyzer', x: 0, y: 0, w: 300, h: 200 },
      { id: 'a', kind: 'waveform', x: 0, y: 0, w: 300, h: 200 },
      { id: 'b', kind: 'not-a-meter', x: 0, y: 0, w: 300, h: 200 },
      { id: 'c', kind: 'loudness', x: 'far', y: null, w: 0, h: 0 },
    ],
  })
  assert.ok(parsed)
  assert.equal(parsed!.name, 'Mine')
  assert.equal(parsed!.palette, 'ice')
  assert.equal(parsed!.snap, false)
  assert.deepEqual(
    parsed!.panels.map((p) => p.kind),
    ['fft-analyzer', 'loudness'],
  )
  assert.equal(validateWorkspace(null), null)
  assert.equal(validateWorkspace('nope'), null)
  assert.equal(parseWorkspace('{invalid'), null)
  assert.ok(parseWorkspace(JSON.stringify(parsed)))
})

test('presets cover both reference figures', () => {
  const scope = WORKSPACE_PRESETS['signal-scope']!.build('ember')
  assert.deepEqual(
    scope.panels.map((p) => p.kind).sort(),
    ['fft-analyzer', 'octave-analyzer', 'oscilloscope', 'spectrogram', 'xy-scope'].sort(),
  )
  const aura = WORKSPACE_PRESETS.aura!.build('ember')
  assert.ok(aura.panels.some((p) => p.kind === 'spectrum-analyzer'))
  assert.ok(aura.panels.some((p) => p.kind === 'waveform'))
  assert.ok(aura.panels.some((p) => p.kind === 'stereo-level'))
  assert.ok(aura.panels.some((p) => p.kind === 'loudness'))
  assert.ok(aura.panels.some((p) => p.kind === 'stereo-field'))
  assert.ok(aura.panels.some((p) => p.kind === 'spectrogram'))
})

test('memory and store workspace storage round-trip', async () => {
  const ws = defaultWorkspace()
  const memory = createMemoryWorkspaceStorage()
  assert.equal(await memory.load(), null)
  await memory.save(ws)
  assert.equal((await memory.load())?.panels.length, 10)

  const backing = new Map<string, unknown>()
  const store = createStoreWorkspaceStorage({
    get: async <T>(key: string): Promise<T | undefined> => backing.get(key) as T | undefined,
    set: async (key, value) => {
      backing.set(key, value)
    },
  })
  await store.save(ws)
  assert.equal((await store.load())?.name, 'Studio')
})

test('clampPanel never lets a panel escape its minimum size', () => {
  const panel = clampPanel({ id: 'x', kind: 'waveform', x: -50, y: -10, w: 10, h: 10 })
  assert.ok(panel.x >= 0 && panel.y >= 0 && panel.w >= 220 && panel.h >= 150)
})

/* ── audio-frame adapter ─────────────────────────────────────────────── */

test('mono visualizer adapter returns a mono frame, silence source returns null', () => {
  const freq = new Uint8Array(64).fill(128)
  const time = new Uint8Array(128).fill(128)
  const source = createVisualizerFrameSource({
    settings: { fftSize: 128 },
    getFrequencyData: (array) => array.set(freq.subarray(0, array.length)),
    getTimeDomainData: (array) => array.set(time.subarray(0, array.length)),
  })
  assert.equal(source.available, true)
  assert.equal(source.channels, 1)
  assert.equal(source.sampleRateHz, undefined)
  const frame = source.pull()!
  assert.equal(frame.channels, 1)
  assert.equal(frame.left, undefined)
  assert.equal(frame.frequencyData.length, 64)
  assert.equal(frame.timeDomainData.length, 128)

  const absent = createVisualizerFrameSource(undefined)
  assert.equal(absent.available, false)
  assert.equal(absent.pull(), null)
})

test('stereo visualizer adapter returns per-channel data only as a package', () => {
  const stereo = {
    settings: { fftSize: 128 },
    channels: 2 as const,
    sampleRateHz: 48000,
    getFrequencyData: (array: Uint8Array) => array.fill(100),
    getTimeDomainData: (array: Uint8Array) => array.fill(128),
    getLeftFrequencyData: (array: Uint8Array) => array.fill(200),
    getLeftTimeDomainData: (array: Uint8Array) => array.fill(220),
    getRightFrequencyData: (array: Uint8Array) => array.fill(10),
    getRightTimeDomainData: (array: Uint8Array) => array.fill(120),
  }
  const frame = createVisualizerFrameSource(stereo).pull()!
  assert.equal(frame.channels, 2)
  assert.equal(frame.sampleRateHz, 48000)
  assert.equal(frame.left!.frequencyData[0], 200)
  assert.equal(frame.right!.frequencyData[0], 10)
  assert.equal(frame.left!.timeDomainData[0], 220)

  // Channels reported without the methods: mono, not half-stereo.
  const partial = createVisualizerFrameSource({
    settings: { fftSize: 128 },
    channels: 2 as const,
    getFrequencyData: (array: Uint8Array) => array.fill(100),
    getTimeDomainData: (array: Uint8Array) => array.fill(128),
  }).pull()!
  assert.equal(partial.channels, 1)
  assert.equal(partial.left, undefined)
})

test('TimeHistory returns oldest-first snapshots', () => {
  const history = new TimeHistory(4)
  history.pushBytes(new Uint8Array([128, 192]))
  history.pushBytes(new Uint8Array([64, 128]))
  assert.deepEqual([...history.snapshot()], [0, 0.5, -0.5, 0])
  history.pushBytes(new Uint8Array([255]))
  assert.deepEqual([...history.snapshot()], [0.5, -0.5, 0, 127 / 128])
})

/* ── new meters math ─────────────────────────────────────────────────── */

test('byteToDb inverts the engine mapping', () => {
  assert.equal(byteToDb(0), -100)
  assert.equal(byteToDb(255), -30)
  assert.ok(Math.abs(byteToDb(128) - -64.7) < 0.5)
})

test('octaveBandEdges drops bands above Nyquist and widens with frequency', () => {
  const bands = octaveBandEdges(2048, 48000, 1)
  assert.ok(bands.length > 0)
  assert.ok(bands.every((b) => b.centreHz < 24000))
  assert.ok(bands.every((b) => b.endBin > b.startBin))
  const widths = bands.map((b) => b.endBin - b.startBin)
  assert.ok(widths[widths.length - 1]! >= widths[0]!)
  // A 128-point FFT cannot resolve low octaves: honest scarcity, not empty bars.
  const coarse = octaveBandEdges(128, 48000, 1)
  assert.ok(coarse.length < bands.length)
  const freq = new Uint8Array(1024).fill(200)
  const values = aggregateOctaveBands(freq, bands)
  assert.ok(values.every((v) => Math.abs(v - 200 / 255) < 1e-6))
})

test('computeStereoLevels: mono correlates 1, out-of-phase -1', () => {
  const l = new Float32Array([0.5, -0.5, 0.5, -0.5])
  const mono = computeStereoLevels(l, l)
  assert.equal(mono.correlation, 1)
  assert.equal(mono.width, 0)
  const neg = new Float32Array([-0.5, 0.5, -0.5, 0.5])
  const anti = computeStereoLevels(l, neg)
  assert.ok(Math.abs(anti.correlation + 1) < 1e-6)
  assert.ok(Math.abs(anti.width - 1) < 1e-6)
  assert.ok(Math.abs(mono.leftRmsDb - -6.0206) < 1e-3)
})

test('loudness: silence stays at the floor, a steady tone converges', () => {
  assert.equal(loudnessFromRms(0), -70)
  assert.ok(Math.abs(loudnessFromRms(1) - -0.691) < 1e-3)
  let state = createLoudnessState()
  assert.equal(state.kWeighted, false, 'byte-derived loudness is never K-weighted')
  for (let i = 0; i < 200; i++) state = stepLoudness(state, 0.5, 100)
  assert.ok(state.momentaryLu > -20 && state.momentaryLu < 0)
  assert.ok(state.shortTermLu > -20 && state.shortTermLu < 0)
  assert.ok(state.integratedLu > -20 && state.integratedLu < 0)
  const silent = stepLoudness(createLoudnessState(), 0, 100)
  assert.equal(silent.integratedLu, -70, 'gated frames do not count toward integrated')
})

test('aura palette runs dark teal to pale mint', () => {
  const aura = buildPaletteLut(PALETTE_STOPS.aura!)
  assert.deepEqual(lutColor(aura, 0), [10, 24, 28])
  assert.deepEqual(lutColor(aura, 255), [210, 255, 235])
  const mid = lutColor(aura, 170)
  assert.ok(mid[1] > 150, 'mid aura values are mint, not grey or hot')
  assert.ok(mid[1] > mid[0] && mid[1] > mid[2], 'mint dominates the mid ramp')
})

test('resampleToLogRows keeps the peak of each log row', () => {
  const freq = new Uint8Array(64)
  freq[32] = 255
  const rows = resampleToLogRows(freq, 8)
  assert.equal(rows.length, 8)
  assert.ok([...rows].includes(255))
})

test('phase-correlation validates as a kind and old workspaces still load', () => {
  const parsed = validateWorkspace({
    name: 'Studio',
    palette: 'aura',
    snap: true,
    panels: [
      { id: 'a', kind: 'phase-correlation', x: 0, y: 0, w: 300, h: 200 },
      { id: 'b', kind: 'not-a-meter', x: 0, y: 0, w: 300, h: 200 },
    ],
  })
  assert.ok(parsed)
  assert.deepEqual(
    parsed!.panels.map((p) => p.kind),
    ['phase-correlation'],
  )
  // Round-trip: the new kind survives serialize/parse.
  assert.ok(parseWorkspace(JSON.stringify(parsed)))
})

test('studioDashboardWorkspace lays out all eleven meters in reference rows', () => {
  const ws = studioDashboardWorkspace('aura')
  assert.equal(ws.name, 'Studio')
  assert.equal(ws.panels.length, 11)
  assert.equal(new Set(ws.panels.map((p) => p.kind)).size, 11)
  assert.ok(ws.panels.some((p) => p.kind === 'phase-correlation'))
  // First row: spectrum (wide) + loudness; every panel is clamped sane.
  const spectrum = ws.panels.find((p) => p.kind === 'spectrum-analyzer')!
  const loudness = ws.panels.find((p) => p.kind === 'loudness')!
  assert.equal(spectrum.y, loudness.y)
  assert.ok(spectrum.w > loudness.w)
  for (const panel of ws.panels) {
    assert.ok(panel.w >= 220 && panel.h >= 150, `${panel.kind} meets panel minimums`)
  }
})
