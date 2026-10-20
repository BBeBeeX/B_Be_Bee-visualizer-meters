/**
 * Pure frame math for the meters — no DOM, no React, no service access.
 *
 * Everything here operates on the byte arrays the `visualizer` service
 * hands out (the Web Audio `AnalyserNode` byte conventions):
 * - frequency data: unsigned bytes, 0 = silence … 255 = max, one entry per
 *   FFT bin (`fftSize / 2` entries);
 * - time-domain data: unsigned bytes centred on 128 (= 0.0 sample).
 *
 * Keeping the math pure is what makes it testable — see
 * `test/meters-math.test.ts` (`npm test`, plain `node --test`).
 */

/** Lowest level the VU scale shows; anything quieter reads as silence. */
export const DB_FLOOR = -60

const clamp = (value: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, value))

/* ── Time-domain levels ─────────────────────────────────────────────────── */

/** Converts one time-domain byte to a float sample in [-1, ~1). */
export function byteToSample(byte: number): number {
  return clamp((byte - 128) / 128, -1, 1)
}

/** Root-mean-square level of a time-domain frame, in [0, 1]. 0 for empty input. */
export function computeRms(timeDomain: Uint8Array): number {
  if (timeDomain.length === 0) return 0
  let sumSquares = 0
  for (let i = 0; i < timeDomain.length; i++) {
    const sample = byteToSample(timeDomain[i]!)
    sumSquares += sample * sample
  }
  return Math.sqrt(sumSquares / timeDomain.length)
}

/** Peak absolute level of a time-domain frame, in [0, 1]. 0 for empty input. */
export function computePeak(timeDomain: Uint8Array): number {
  let peak = 0
  for (let i = 0; i < timeDomain.length; i++) {
    const magnitude = Math.abs(byteToSample(timeDomain[i]!))
    if (magnitude > peak) peak = magnitude
  }
  return peak
}

/** Converts a linear level (0..1) to decibels, clamped to [floorDb, 0]. */
export function levelToDb(level: number, floorDb: number = DB_FLOOR): number {
  if (!(level > 0)) return floorDb
  return clamp(20 * Math.log10(level), floorDb, 0)
}

/** Inverse display mapping: decibels → 0..1 fraction of the meter scale. */
export function dbToFraction(db: number, floorDb: number = DB_FLOOR): number {
  return clamp((db - floorDb) / (0 - floorDb), 0, 1)
}

/* ── VU ballistics ──────────────────────────────────────────────────────── */

/**
 * VU meter motion state, in decibels. Frame-based (not wall-clock) so the
 * behaviour is deterministic and unit-testable; the view steps it once per
 * animation frame.
 *
 * Ballistics, the classic broadcast compromise:
 * - the level bar attacks instantly (a transient is never missed) and
 *   releases at a fixed dB-per-frame rate toward the current RMS;
 * - the peak marker jumps to any new peak, *holds* for a fixed number of
 *   frames, then falls slowly — and never below the current frame's peak.
 */
export interface VuState {
  levelDb: number
  peakDb: number
  peakHoldFramesLeft: number
}

export interface VuOptions {
  /** How fast the level bar falls toward a quieter RMS, dB per frame. */
  releaseDbPerFrame: number
  /** How fast the peak marker falls once its hold expires, dB per frame. */
  peakFallDbPerFrame: number
  /** Frames the peak marker stays pinned after a new peak. */
  peakHoldFrames: number
}

/** Tuned for ~60 fps: level settles in ≈⅔ s, peak holds ≈¾ s then drifts down. */
export const DEFAULT_VU_OPTIONS: VuOptions = {
  releaseDbPerFrame: 0.9,
  peakFallDbPerFrame: 0.35,
  peakHoldFrames: 45,
}

export function createVuState(floorDb: number = DB_FLOOR): VuState {
  return { levelDb: floorDb, peakDb: floorDb, peakHoldFramesLeft: 0 }
}

/** Advances the VU state by one frame. Pure: returns a new state object. */
export function stepVu(
  state: VuState,
  rmsDb: number,
  peakDb: number,
  options: VuOptions = DEFAULT_VU_OPTIONS,
  floorDb: number = DB_FLOOR,
): VuState {
  const nextRms = clamp(rmsDb, floorDb, 0)
  const nextPeakIn = clamp(peakDb, floorDb, 0)

  // Level: instant attack, rate-limited release.
  const levelDb =
    nextRms >= state.levelDb
      ? nextRms
      : Math.max(nextRms, state.levelDb - options.releaseDbPerFrame)

  // Peak: jump + hold on a new maximum, otherwise count down and fall.
  let nextPeakDb = state.peakDb
  let holdLeft = state.peakHoldFramesLeft
  if (nextPeakIn >= state.peakDb) {
    nextPeakDb = nextPeakIn
    holdLeft = options.peakHoldFrames
  } else if (holdLeft > 0) {
    holdLeft -= 1
  } else {
    nextPeakDb = Math.max(nextPeakIn, state.peakDb - options.peakFallDbPerFrame)
  }

  return { levelDb, peakDb: clamp(nextPeakDb, floorDb, 0), peakHoldFramesLeft: holdLeft }
}

/* ── Spectrum band mapping (logarithmic) ────────────────────────────────── */

/**
 * Splits the usable FFT bins into `bandCount` logarithmically spaced bands.
 *
 * Human pitch perception is logarithmic, so linear bin groups would give
 * the bass half the display and crowd everything above 1 kHz into a few
 * bars. Band edges therefore grow geometrically from bin 1 (bin 0 is DC and
 * carries no pitch information) to `binCount`. Each band is a half-open
 * `[start, end)` bin range; bands are non-empty and contiguous.
 */
export function logBandEdges(
  binCount: number,
  bandCount: number,
): Array<readonly [number, number]> {
  const usable = Math.max(0, binCount - 1)
  const bands = Math.max(1, Math.min(bandCount, Math.max(1, usable)))
  const edges: Array<readonly [number, number]> = []
  let start = 1
  for (let i = 0; i < bands; i++) {
    const t = (i + 1) / bands
    const end = i === bands - 1 ? binCount : Math.round(Math.exp(Math.log(1) + Math.log(binCount) * t))
    const clampedEnd = Math.min(binCount, Math.max(start + 1, end))
    edges.push([start, clampedEnd] as const)
    start = clampedEnd
  }
  return edges
}

/**
 * Aggregates byte frequency data into one 0..1 value per band.
 * Uses the band *maximum* (not the mean): a narrow peak inside a wide
 * high-frequency band should still light the band up; the mean would wash
 * it out as bands widen.
 */
export function aggregateBands(
  frequencyData: Uint8Array,
  edges: Array<readonly [number, number]>,
): Float32Array {
  const out = new Float32Array(edges.length)
  for (let b = 0; b < edges.length; b++) {
    const [start, end] = edges[b]!
    let max = 0
    const stop = Math.min(end, frequencyData.length)
    for (let i = start; i < stop; i++) {
      const value = frequencyData[i]!
      if (value > max) max = value
    }
    out[b] = max / 255
  }
  return out
}

/* ── Spectrogram waterfall ──────────────────────────────────────────────── */

/**
 * Ring buffer of past spectrum frames for the spectrogram.
 *
 * Columns are stored in a circular array so pushing a frame is O(height)
 * with no shifting; `columnAtAge(0)` is always the newest frame, which is
 * what the renderer walks (it draws age `width-1` … `0` left → right, so
 * time flows left-to-right and history scrolls away to the left).
 */
export class WaterfallBuffer {
  readonly width: number
  readonly height: number
  private readonly columns: Uint8Array[]
  private head = 0
  private filled = 0

  constructor(width: number, height: number) {
    this.width = Math.max(1, Math.floor(width))
    this.height = Math.max(1, Math.floor(height))
    this.columns = Array.from({ length: this.width }, () => new Uint8Array(this.height))
  }

  /** Number of frames currently stored (≤ width). */
  get size(): number {
    return this.filled
  }

  /** Stores one frame (a column of `height` byte values; extra values are dropped). */
  push(frame: ArrayLike<number>): void {
    const column = this.columns[this.head]!
    const n = Math.min(this.height, frame.length)
    for (let i = 0; i < n; i++) column[i] = frame[i]!
    for (let i = n; i < this.height; i++) column[i] = 0
    this.head = (this.head + 1) % this.width
    if (this.filled < this.width) this.filled += 1
  }

  /** Returns the frame `age` pushes ago (0 = newest), or undefined if not stored yet. */
  columnAtAge(age: number): Uint8Array | undefined {
    if (age < 0 || age >= this.filled) return undefined
    const index = (this.head - 1 - age + this.width * 2) % this.width
    return this.columns[index]
  }

  clear(): void {
    this.head = 0
    this.filled = 0
    for (const column of this.columns) column.fill(0)
  }
}

/* ── Pseudocolor palettes ───────────────────────────────────────────────── */

export type RgbStop = readonly [number, number, number]

/**
 * Palette stop lists, interpolated linearly into a 256-entry LUT.
 * `ember` is the classic black → purple → orange → yellow heat scale;
 * `ice` runs black → deep blue → cyan → white; `mono` is a plain ramp.
 */
export const PALETTE_STOPS: Record<string, readonly RgbStop[]> = {
  ember: [
    [0, 0, 0],
    [64, 0, 128],
    [255, 96, 0],
    [255, 224, 64],
  ],
  ice: [
    [0, 0, 0],
    [0, 32, 96],
    [0, 160, 200],
    [235, 250, 255],
  ],
  mono: [
    [0, 0, 0],
    [96, 96, 96],
    [192, 192, 192],
    [255, 255, 255],
  ],
}

/** Builds a 256×3 RGB lookup table by interpolating the given stops. */
export function buildPaletteLut(stops: readonly RgbStop[]): Uint8Array {
  const lut = new Uint8Array(256 * 3)
  if (stops.length === 0) return lut
  if (stops.length === 1) {
    const [r, g, b] = stops[0]!
    for (let i = 0; i < 256; i++) {
      lut[i * 3] = r
      lut[i * 3 + 1] = g
      lut[i * 3 + 2] = b
    }
    return lut
  }
  const segments = stops.length - 1
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * segments
    const segment = Math.min(segments - 1, Math.floor(t))
    const local = t - segment
    const a = stops[segment]!
    const b = stops[segment + 1]!
    lut[i * 3] = Math.round(a[0] + (b[0] - a[0]) * local)
    lut[i * 3 + 1] = Math.round(a[1] + (b[1] - a[1]) * local)
    lut[i * 3 + 2] = Math.round(a[2] + (b[2] - a[2]) * local)
  }
  return lut
}

/** Looks up the RGB triple for a byte level (0..255) in a LUT from {@link buildPaletteLut}. */
export function lutColor(lut: Uint8Array, byteValue: number): RgbStop {
  const index = clamp(Math.round(byteValue), 0, 255) * 3
  return [lut[index]!, lut[index + 1]!, lut[index + 2]!] as const
}
