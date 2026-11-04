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

/* ── FFT byte → dB ──────────────────────────────────────────────────────── */

/**
 * Maps an engine frequency byte back to decibels. The engine (and Web
 * Audio's defaults) map `minDb…maxDb` onto 0…255, so the inverse is
 * linear in dB. The defaults are the engine's own (`FftOptions`:
 * −100…−30); pass the host's range explicitly when it is known to
 * differ. This is an *engine-mapped* dB, not raw dBFS — the sensitivity
 * multiplier in `plugin-visualizer` scales bytes before meters see them.
 */
export function byteToDb(byteValue: number, minDb = -100, maxDb = -30): number {
  const t = clamp(byteValue, 0, 255) / 255
  return minDb + t * (maxDb - minDb)
}

/* ── Octave bands ───────────────────────────────────────────────────────── */

/**
 * One octave band: its nominal centre, its −3 dB edges, and the FFT bin
 * range that covers it. Bin frequencies are `bin * sampleRate / fftSize`;
 * bin 0 (DC) is excluded, as in {@link logBandEdges}.
 */
export interface OctaveBand {
  centreHz: number
  lowHz: number
  highHz: number
  startBin: number
  endBin: number
}

/** Standard 1/1-octave nominal centres (IEC 61260), 31.5 Hz…16 kHz. */
export const OCTAVE_1_CENTRES: readonly number[] = [
  31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
]

/** Standard 1/3-octave nominal centres, 25 Hz…20 kHz. */
export const OCTAVE_THIRD_CENTRES: readonly number[] = [
  25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800,
  1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500,
  16000, 20000,
]

/**
 * Builds the octave bands that fit inside Nyquist for this FFT size and
 * sample rate. Bands above Nyquist are dropped (a 128-point FFT at
 * 48 kHz resolves nothing above ~125 Hz per bin, so the high bands
 * simply do not exist — the meter shows fewer bars and says why,
 * rather than drawing empty bars). `fraction` is 1 for 1/1-octave,
 * 3 for 1/3-octave.
 */
export function octaveBandEdges(
  fftSize: number,
  sampleRateHz: number,
  fraction: 1 | 3,
): OctaveBand[] {
  const binCount = Math.floor(fftSize / 2)
  if (binCount <= 1 || !(sampleRateHz > 0)) return []
  const binHz = sampleRateHz / fftSize
  const nyquist = sampleRateHz / 2
  const halfWidthFactor = 2 ** (1 / (2 * fraction))
  const centres = fraction === 1 ? OCTAVE_1_CENTRES : OCTAVE_THIRD_CENTRES
  const bands: OctaveBand[] = []
  for (const centreHz of centres) {
    if (centreHz >= nyquist) break
    const lowHz = centreHz / halfWidthFactor
    const highHz = Math.min(centreHz * halfWidthFactor, nyquist)
    const startBin = Math.max(1, Math.floor(lowHz / binHz))
    const endBin = Math.min(binCount, Math.ceil(highHz / binHz))
    // A band narrower than one bin carries no information about its
    // centre frequency (at fftSize 128, a 31.5 Hz band is one 375 Hz
    // bin wide) — drop it rather than drawing a bar that lies.
    if (endBin <= startBin) continue
    bands.push({ centreHz, lowHz, highHz, startBin, endBin })
  }
  return bands
}

/** Aggregates byte frequency data into one 0..1 value per octave band (band maximum). */
export function aggregateOctaveBands(
  frequencyData: Uint8Array,
  bands: readonly OctaveBand[],
): Float32Array {
  const out = new Float32Array(bands.length)
  for (let b = 0; b < bands.length; b++) {
    const band = bands[b]!
    let max = 0
    const stop = Math.min(band.endBin, frequencyData.length)
    for (let i = band.startBin; i < stop; i++) {
      const value = frequencyData[i]!
      if (value > max) max = value
    }
    out[b] = max / 255
  }
  return out
}

/** Resamples a linear-bin frequency frame to log-spaced rows (for the spectrogram). */
export function resampleToLogRows(frequencyData: Uint8Array, rows: number): Uint8Array {
  const out = new Uint8Array(Math.max(1, rows))
  const binCount = frequencyData.length
  if (binCount === 0) return out
  for (let row = 0; row < out.length; row++) {
    // Row 0 = lowest frequency. Edges grow geometrically from bin 1.
    const t0 = row / out.length
    const t1 = (row + 1) / out.length
    const start = Math.max(1, Math.floor(Math.exp(Math.log(1) + Math.log(binCount) * t0)))
    const end = Math.min(binCount, Math.max(start + 1, Math.floor(Math.exp(Math.log(1) + Math.log(binCount) * t1))))
    let max = 0
    for (let i = start; i < end; i++) {
      const value = frequencyData[i]!
      if (value > max) max = value
    }
    out[row] = max
  }
  return out
}

/* ── Stereo levels, correlation, width ──────────────────────────────────── */

/** Per-channel levels plus the stereo image, all from float samples. */
export interface StereoLevels {
  leftRmsDb: number
  rightRmsDb: number
  leftPeakDb: number
  rightPeakDb: number
  /** Pearson correlation of the paired samples, −1 (out of phase)…1 (mono). */
  correlation: number
  /**
   * Stereo width in 0…1, defined as `(1 − correlation) / 2`: mono reads
   * 0, decorrelated reads 0.5, fully out of phase reads 1. This is a
   * display quantity, not a codec parameter.
   */
  width: number
}

function rmsOf(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!
  return Math.sqrt(sum / samples.length)
}

function peakOf(samples: Float32Array): number {
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const magnitude = Math.abs(samples[i]!)
    if (magnitude > peak) peak = magnitude
  }
  return peak
}

/**
 * Computes stereo levels from paired float samples (same length; the
 * shorter length wins). Pure, so the XY scope, stereo field and stereo
 * level meter all agree on one definition.
 */
export function computeStereoLevels(
  left: Float32Array,
  right: Float32Array,
): StereoLevels {
  const n = Math.min(left.length, right.length)
  const leftRms = rmsOf(left.subarray(0, n))
  const rightRms = rmsOf(right.subarray(0, n))
  let dot = 0
  let leftEnergy = 0
  let rightEnergy = 0
  for (let i = 0; i < n; i++) {
    const l = left[i]!
    const r = right[i]!
    dot += l * r
    leftEnergy += l * l
    rightEnergy += r * r
  }
  const denom = Math.sqrt(leftEnergy * rightEnergy)
  const correlation = denom > 0 ? clamp(dot / denom, -1, 1) : 0
  return {
    leftRmsDb: levelToDb(leftRms),
    rightRmsDb: levelToDb(rightRms),
    leftPeakDb: levelToDb(peakOf(left.subarray(0, n))),
    rightPeakDb: levelToDb(peakOf(right.subarray(0, n))),
    correlation,
    width: (1 - correlation) / 2,
  }
}

/* ── Loudness (approximate — read this before quoting a number) ────────── */

/**
 * Loudness state, in LUFS-approximate units. The approximation is stated
 * plainly because quoting "LUFS" without it would be false precision:
 *
 * - The input is byte time-domain data (8-bit, mono, sensitivity-scaled
 *   by the visualizer), not float PCM, so there is no K-weighting
 *   filter (which needs the sample rate and a filter) and no true
 *   channel weighting. The conversion is `20·log10(RMS) − 0.691` (the
 *   BS.1770 offset, without the filter) on the energy domain.
 * - Momentary smooths energy with τ = 400 ms, short-term with τ = 3 s
 *   (both per BS.1770 windows, applied to energy, not to dB).
 * - Integrated is the gated mean energy since the meter started, with
 *   only the −70 LUFS absolute gate (the relative −10 LU gate needs a
 *   second pass over blocks and is omitted).
 * - LRA is the 95th − 10th percentile spread of the short-term history
 *   kept in this state (capped, so it is a windowed LRA, not a
 *   full-track one).
 *
 * When a stereo float-PCM source with a known sample rate arrives (see
 * `audio-frame.ts`), the same state machine takes float RMS and a
 * K-weighted energy, and the numbers stop being approximate — the
 * interface already carries the fields for it via `kWeighted`.
 */
export const LOUDNESS_FLOOR = -70

export interface LoudnessState {
  /** Energy-domain smoothed momentary loudness. */
  momentaryLu: number
  shortTermLu: number
  integratedLu: number
  /** Windowed loudness range from the capped short-term history. */
  lraLu: number
  /** False until a K-weighted source feeds this state. */
  kWeighted: boolean
  /** Internal accumulators (energy domain). Not display values. */
  momentaryEnergy: number
  shortTermEnergy: number
  integratedEnergy: number
  integratedCount: number
  shortHistory: number[]
}

export function createLoudnessState(): LoudnessState {
  return {
    momentaryLu: LOUDNESS_FLOOR,
    shortTermLu: LOUDNESS_FLOOR,
    integratedLu: LOUDNESS_FLOOR,
    lraLu: 0,
    kWeighted: false,
    momentaryEnergy: 0,
    shortTermEnergy: 0,
    integratedEnergy: 0,
    integratedCount: 0,
    shortHistory: [],
  }
}

export function loudnessFromRms(rms: number): number {
  if (!(rms > 0)) return LOUDNESS_FLOOR
  return Math.max(LOUDNESS_FLOOR, 20 * Math.log10(rms) - 0.691)
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return LOUDNESS_FLOOR
  const index = clamp(Math.floor(p * sorted.length), 0, sorted.length - 1)
  return sorted[index]!
}

/**
 * Advances loudness by one step. `rms` is the frame's linear RMS
 * (0..1); `dtMs` is the real time since the previous step — pass the
 * frame timestamp delta, not a frame count, or the τ windows drift
 * with frame rate. Returns a new state (the history array is copied,
 * capped at 600 entries).
 */
export function stepLoudness(
  state: LoudnessState,
  rms: number,
  dtMs: number,
): LoudnessState {
  const dt = Math.min(1000, Math.max(1, dtMs)) / 1000
  const energy = rms * rms
  const momentaryAlpha = 1 - Math.exp(-dt / 0.4)
  const shortAlpha = 1 - Math.exp(-dt / 3)
  const momentaryEnergy =
    state.momentaryEnergy + momentaryAlpha * (energy - state.momentaryEnergy)
  const shortTermEnergy =
    state.shortTermEnergy + shortAlpha * (energy - state.shortTermEnergy)
  const momentaryLu = loudnessFromRms(Math.sqrt(Math.max(0, momentaryEnergy)))
  const shortTermLu = loudnessFromRms(Math.sqrt(Math.max(0, shortTermEnergy)))

  let integratedEnergy = state.integratedEnergy
  let integratedCount = state.integratedCount
  // Absolute gate only (see the header): quiet frames do not drag the
  // integrated value down, they are simply not counted.
  if (momentaryLu > LOUDNESS_FLOOR) {
    integratedEnergy += energy
    integratedCount += 1
  }
  const integratedLu =
    integratedCount > 0
      ? loudnessFromRms(Math.sqrt(integratedEnergy / integratedCount))
      : LOUDNESS_FLOOR

  const shortHistory = [...state.shortHistory, shortTermLu].slice(-600)
  const sorted = [...shortHistory].sort((a, b) => a - b)
  const lraLu =
    shortHistory.length >= 10 ? percentile(sorted, 0.95) - percentile(sorted, 0.1) : 0

  return {
    momentaryLu,
    shortTermLu,
    integratedLu,
    lraLu,
    kWeighted: state.kWeighted,
    momentaryEnergy,
    shortTermEnergy,
    integratedEnergy,
    integratedCount,
    shortHistory,
  }
}

