/**
 * audio-frame.ts — the real-time audio data interface for the meters.
 *
 * This is the one place where a meter touches the host's live audio.
 * Everything downstream (the ten meter components in `./meters.tsx`, the
 * pure math in `./meters-math.ts`) consumes only the types here, so the
 * day a stereo source exists, only the *source* changes — no meter does.
 *
 * ## What a frame carries
 *
 * - `frequencyData` / `timeDomainData`: the mono mix (or channel 0), in
 *   the Web Audio `AnalyserNode` byte conventions the `visualizer`
 *   service already speaks — frequency bytes 0..255 (engine-mapped,
 *   roughly −100…−30 dB), time bytes centred on 128 (= 0.0).
 * - `left` / `right`: per-channel byte data. **Absent today, by design.**
 *   The current chain downmixes to mono before any meter sees it (see
 *   "Why stereo meters show a placeholder" below), so a meter that needs
 *   stereo must check `channels === 2` and render an honest placeholder
 *   instead of inventing a second channel from the mono mix. A mono mix
 *   copied to both channels would draw a perfect diagonal on the XY
 *   scope and a zero-width stereo field — a lie that looks like data.
 * - `sampleRateHz`: absent today. The `visualizer` service does not
 *   expose it, so frequency/time axes that need it (octave bands,
 *   oscilloscope milliseconds) fall back to a nominal 48 kHz and say so
 *   on the panel. When the host supplies it, the same meters become
 *   exact with no code change.
 *
 * ## Why stereo meters show a placeholder (the audio-engine answer)
 *
 * `audio-engine`'s `FftProcessor::processInterleaved` downmixes every
 * channel to mono before the FFT, and the NDJSON `fft-frame` it emits
 * carries only that mono pair. `plugin-visualizer`'s `NativeMpvImpl`
 * then smooths the mono spectrum and hands it out through
 * `getFrequencyData` / `getTimeDomainData`. Nothing in the meters repo
 * can recover L/R from that — the information is gone upstream. True
 * stereo meters (XY scope, stereo field, per-channel levels, BS.1770
 * loudness) need the engine to keep per-channel PCM/FFT and the
 * `visualizer` service to expose it; the minimal change set is listed
 * in the README section "Stereo data: what audio-engine must change".
 * This file is already shaped for that frame: `left` / `right` and
 * `sampleRateHz` are optional fields, not a second interface.
 *
 * ## Frame stitching caveat
 *
 * `TimeHistory` concatenates successive time-domain frames for the
 * waveform view. Those frames are the analyser's latest FFT window each
 * tick, not a guaranteed-contiguous PCM stream (the native poller may
 * skip or repeat a window), so the waveform time axis is approximate
 * and labelled as such. A sample-accurate oscilloscope needs a PCM
 * stream, not analyser windows — same upstream change as stereo.
 */

/**
 * Local copy of `byteToSample` from `./meters-math.ts` (same formula:
 * (byte − 128) / 128, clamped to [−1, 1]). This module intentionally
 * imports nothing so it stays runnable under plain `node --test`,
 * which does not resolve `.js` → `.ts` specifiers; keep the two in
 * sync — the test in `test/workspace.test.ts` pins the shared values.
 */
function byteToSample(byte: number): number {
  return Math.min(1, Math.max(-1, (byte - 128) / 128))
}

/** The slice of the `visualizer` service this file adapts (see ui.tsx). */
export interface VisualizerLike {
  readonly settings: { fftSize?: number }
  getFrequencyData(array: Uint8Array): void
  getTimeDomainData(array: Uint8Array): void
}

/** One channel's byte data, in AnalyserNode conventions. */
export interface ChannelAudioData {
  frequencyData: Uint8Array
  timeDomainData: Uint8Array
}

/**
 * One pulled audio frame. `frequencyData` / `timeDomainData` are always
 * present (mono mix when `channels === 1`); `left` / `right` are present
 * only when `channels === 2`.
 */
export interface AudioFrame {
  timestampMs: number
  /** Sample rate in Hz. Undefined = unknown; meters assume 48 kHz and say so. */
  sampleRateHz?: number
  channels: 1 | 2
  frequencyData: Uint8Array
  timeDomainData: Uint8Array
  left?: ChannelAudioData
  right?: ChannelAudioData
}

/**
 * A pull-based live source. `pull()` returns the newest frame, or null
 * when no live source is attached (meters then draw their baseline /
 * placeholder, never throw). Pulling is cheap — byte copies out of the
 * analyser — so each meter panel pulls its own frame; a shared-source
 * optimisation is only worth it if panel counts grow well past ten.
 */
export interface FrameSource {
  /** 1 today (mono adapter below); 2 once a stereo source is wired in. */
  readonly channels: 1 | 2
  readonly sampleRateHz?: number
  readonly available: boolean
  pull(): AudioFrame | null
}

export function clampFftSize(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 128
  const power = Math.round(Math.log2(value))
  return Math.min(2048, Math.max(32, 2 ** power))
}

/**
 * Adapts the existing mono `visualizer` service to a `FrameSource`.
 * This is the only adapter that exists today, and it is honest about
 * it: `channels` is 1, `sampleRateHz` is undefined, `left`/`right` are
 * absent. A future stereo adapter implements the same interface and
 * the meters do not change.
 */
export function createVisualizerFrameSource(
  visualizer: VisualizerLike | undefined,
): FrameSource {
  if (!visualizer) {
    return {
      channels: 1,
      sampleRateHz: undefined,
      available: false,
      pull: () => null,
    }
  }
  let fftSize = 0
  let freq = new Uint8Array(0)
  let time = new Uint8Array(0)
  return {
    channels: 1,
    sampleRateHz: undefined,
    available: true,
    pull: (): AudioFrame => {
      const target = clampFftSize(visualizer.settings?.fftSize ?? 128)
      if (target !== fftSize) {
        fftSize = target
        freq = new Uint8Array(fftSize / 2)
        time = new Uint8Array(fftSize)
      }
      visualizer.getFrequencyData(freq)
      visualizer.getTimeDomainData(time)
      return {
        timestampMs: Date.now(),
        sampleRateHz: undefined,
        channels: 1,
        // Copy: the analyser reuses its own buffers, and meters (notably
        // the waterfall and waveform history) retain frames across ticks.
        frequencyData: freq.slice(),
        timeDomainData: time.slice(),
      }
    },
  }
}

/**
 * Ring of past time-domain samples, oldest → newest, for the waveform
 * view. Capacity is in samples; pushing a frame converts its bytes to
 * floats. See the module header for why this is frame-stitched, not
 * sample-accurate.
 */
export class TimeHistory {
  readonly capacity: number
  private readonly buffer: Float32Array
  private head = 0
  private filled = 0

  constructor(capacitySamples: number) {
    this.capacity = Math.max(1, Math.floor(capacitySamples))
    this.buffer = new Float32Array(this.capacity)
  }

  get size(): number {
    return this.filled
  }

  pushBytes(timeBytes: Uint8Array): void {
    for (let i = 0; i < timeBytes.length; i++) {
      this.buffer[this.head] = byteToSample(timeBytes[i]!)
      this.head = (this.head + 1) % this.capacity
      if (this.filled < this.capacity) this.filled += 1
    }
  }

  pushFloat(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      this.buffer[this.head] = samples[i]!
      this.head = (this.head + 1) % this.capacity
      if (this.filled < this.capacity) this.filled += 1
    }
  }

  /** Oldest → newest snapshot (a fresh array; callers may slice a window). */
  snapshot(): Float32Array {
    const out = new Float32Array(this.filled)
    for (let i = 0; i < this.filled; i++) {
      out[i] = this.buffer[(this.head - this.filled + i + this.capacity * 2) % this.capacity]!
    }
    return out
  }

  clear(): void {
    this.head = 0
    this.filled = 0
    this.buffer.fill(0)
  }
}

/** Converts one time-domain byte frame to float samples in [-1, 1). */
export function samplesFromBytes(timeBytes: Uint8Array): Float32Array {
  const out = new Float32Array(timeBytes.length)
  for (let i = 0; i < timeBytes.length; i++) out[i] = byteToSample(timeBytes[i]!)
  return out
}
