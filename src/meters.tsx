/**
 * meters.tsx — ten independent meter components.
 *
 * Each component is self-contained: it takes a `FrameSource` (see
 * `./audio-frame.ts`), pulls one frame per animation tick, and draws
 * itself on its own canvas. No component knows about the workspace,
 * the panel chrome, or any other meter — the workspace in `./ui.tsx`
 * only composes them. That independence is the point: a meter can be
 * embedded anywhere a `FrameSource` can be handed to it.
 *
 * Honesty rules, applied uniformly:
 * - No live frame → quiet baseline, never a throw.
 * - Mono source + stereo meter → an explicit "needs stereo data"
 *   placeholder, never a mono copy masquerading as two channels.
 * - Unknown sample rate → axes are labelled with the nominal 48 kHz
 *   assumption, in the drawing itself, not just in docs.
 * - Loudness numbers are labelled approximate (see `meters-math.ts`).
 * - The waveform history is labelled frame-stitched (see
 *   `audio-frame.ts`).
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactElement, RefObject } from 'react'
import type { AudioFrame, FrameSource } from './audio-frame.js'
import { samplesFromBytes, TimeHistory } from './audio-frame.js'
import type { MetersPaletteName } from './config.js'
import {
  aggregateBands,
  aggregateOctaveBands,
  buildPaletteLut,
  byteToDb,
  computeRms,
  computeStereoLevels,
  createLoudnessState,
  createVuState,
  dbToFraction,
  DB_FLOOR,
  logBandEdges,
  lutColor,
  octaveBandEdges,
  PALETTE_STOPS,
  resampleToLogRows,
  stepLoudness,
  stepVu,
  WaterfallBuffer,
  type LoudnessState,
  type VuState,
} from './meters-math.js'
import type { MeterKind } from './workspace.js'
import { AURA } from './aura-theme.js'

/* ── Shared canvas plumbing ────────────────────────────────────────────── */

export interface MeterProps {
  source: FrameSource
  palette: MetersPaletteName
  zoom?: number
}

type DrawFn = (
  g: CanvasRenderingContext2D,
  w: number,
  h: number,
  frame: AudioFrame | null,
) => void

const lutCache = new Map<MetersPaletteName, Uint8Array>()
function lutFor(palette: MetersPaletteName): Uint8Array {
  let lut = lutCache.get(palette)
  if (!lut) {
    lut = buildPaletteLut(PALETTE_STOPS[palette] ?? PALETTE_STOPS.ember!)
    lutCache.set(palette, lut)
  }
  return lut
}

function sampleRateOf(frame: AudioFrame | null): { hz: number; assumed: boolean } {
  if (frame?.sampleRateHz && frame.sampleRateHz > 0) {
    return { hz: frame.sampleRateHz, assumed: false }
  }
  return { hz: 48000, assumed: true }
}

function formatHz(hz: number): string {
  if (hz >= 1000) return `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1)}k`
  return `${Math.round(hz)}`
}

function drawPlaceholder(
  g: CanvasRenderingContext2D,
  w: number,
  h: number,
  lines: string[],
): void {
  g.fillStyle = AURA.muted
  g.font = '12px sans-serif'
  g.textAlign = 'center'
  lines.forEach((line, i) => {
    g.fillText(line, w / 2, h / 2 + (i - (lines.length - 1) / 2) * 16)
  })
  g.textAlign = 'left'
}

function drawNote(
  g: CanvasRenderingContext2D,
  w: number,
  h: number,
  text: string,
): void {
  g.fillStyle = AURA.muted
  g.font = '10px sans-serif'
  g.textAlign = 'right'
  g.fillText(text, w - 4, h - 4)
  g.textAlign = 'left'
}

function gridLines(
  g: CanvasRenderingContext2D,
  w: number,
  h: number,
  xs: number[],
  ys: number[],
): void {
  g.strokeStyle = AURA.grid
  g.lineWidth = 1
  g.beginPath()
  for (const x of xs) {
    g.moveTo(x, 0)
    g.lineTo(x, h)
  }
  for (const y of ys) {
    g.moveTo(0, y)
    g.lineTo(w, y)
  }
  g.stroke()
}

/**
 * One rAF loop per meter: pull a frame, draw it, repeat. The draw
 * function is read through a ref so control changes (palette, zoom)
 * never tear the loop down; per-meter state (waterfall, VU, loudness,
 * history) lives in the component's refs and survives loop restarts.
 */
function useMeterCanvas(
  source: FrameSource,
  draw: DrawFn,
  deps: readonly unknown[],
): RefObject<HTMLCanvasElement | null> {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const drawRef = useRef(draw)
  drawRef.current = draw

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const g = canvas.getContext('2d')
    if (!g) return
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    let cssWidth = 320
    let cssHeight = 200
    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      cssWidth = rect.width || 320
      cssHeight = rect.height || 200
      canvas.width = Math.max(1, Math.floor(cssWidth * dpr))
      canvas.height = Math.max(1, Math.floor(cssHeight * dpr))
    }
    resize()
    const observer =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null
    observer?.observe(canvas)
    let animId = 0
    const render = () => {
      animId = requestAnimationFrame(render)
      const frame = source.available ? source.pull() : null
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, cssWidth, cssHeight)
      drawRef.current(g, cssWidth, cssHeight, frame)
    }
    animId = requestAnimationFrame(render)
    return () => {
      if (animId) cancelAnimationFrame(animId)
      observer?.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, ...deps])

  return canvasRef
}

function MeterShell({
  canvasRef,
  children,
}: {
  canvasRef: RefObject<HTMLCanvasElement | null>
  children?: ReactElement | null
}): ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
      {children}
      <canvas
        ref={canvasRef}
        style={{ width: '100%', flex: 1, minHeight: 0, display: 'block' }}
      />
    </div>
  )
}

/* ── 1. FFT Analyzer — per-bin line on a dB scale ─────────────────────── */

function FftAnalyzer({ source, palette, zoom = 1 }: MeterProps): ReactElement {
  const peakRef = useRef<Float32Array | null>(null)
  const ref = useMeterCanvas(
    source,
    (g, w, h, frame) => {
      const lut = lutFor(palette)
      const maxFreq = 20000 / Math.max(0.5, zoom)
      const minFreq = 20
      if (!frame || frame.frequencyData.length === 0) {
        drawPlaceholder(g, w, h, ['No live audio frame'])
        return
      }
      const { hz: sr, assumed } = sampleRateOf(frame)
      const fftSize = frame.frequencyData.length * 2
      const binHz = sr / fftSize
      const logX = (freq: number) =>
        ((Math.log(Math.max(minFreq, freq)) - Math.log(minFreq)) /
          (Math.log(maxFreq) - Math.log(minFreq))) * w
      const dbY = (db: number) => h - 14 - ((db + 100) / 70) * (h - 28)
      const xs = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
        .filter((f) => f >= minFreq && f <= maxFreq)
        .map(logX)
      const ys = [-90, -60, -30].map(dbY)
      gridLines(g, w, h, xs, ys)
      g.fillStyle = AURA.muted
      g.font = '10px sans-serif'
      for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
        if (f < minFreq || f > maxFreq) continue
        g.fillText(formatHz(f), Math.min(w - 24, logX(f) + 2), h - 2)
      }
      for (const db of [-90, -60, -30]) g.fillText(`${db}`, 2, dbY(db) - 2)
      if (!peakRef.current || peakRef.current.length !== frame.frequencyData.length) {
        peakRef.current = new Float32Array(frame.frequencyData.length)
      }
      const peak = peakRef.current
      const [pr, pg, pb] = lutColor(lut, 255)
      // AURA fill: the mint gradient under the line, fading to the card.
      const points: Array<readonly [number, number]> = []
      for (let bin = 1; bin < frame.frequencyData.length; bin++) {
        const freq = bin * binHz
        if (freq < minFreq || freq > maxFreq) continue
        const value = frame.frequencyData[bin]!
        peak[bin] = Math.max(peak[bin]! - 0.5, value)
        points.push([logX(freq), dbY(byteToDb(value))] as const)
      }
      if (points.length > 1) {
        const fill = g.createLinearGradient(0, 0, 0, h)
        fill.addColorStop(0, 'rgba(127, 231, 196, 0.32)')
        fill.addColorStop(1, 'rgba(127, 231, 196, 0)')
        g.fillStyle = fill
        g.beginPath()
        g.moveTo(points[0]![0], h - 14)
        for (const [x, y] of points) g.lineTo(x, y)
        g.lineTo(points[points.length - 1]![0], h - 14)
        g.closePath()
        g.fill()
      }
      g.strokeStyle = `rgb(${pr}, ${pg}, ${pb})`
      g.lineWidth = 1.5
      g.beginPath()
      let started = false
      for (const [x, y] of points) {
        if (!started) {
          g.moveTo(x, y)
          started = true
        } else g.lineTo(x, y)
      }
      g.stroke()
      g.strokeStyle = AURA.peakSoft
      g.lineWidth = 1
      g.beginPath()
      started = false
      for (let bin = 1; bin < frame.frequencyData.length; bin++) {
        const freq = bin * binHz
        if (freq < minFreq || freq > maxFreq) continue
        const x = logX(freq)
        const y = dbY(byteToDb(peak[bin]!))
        if (!started) {
          g.moveTo(x, y)
          started = true
        } else g.lineTo(x, y)
      }
      g.stroke()
      if (assumed) drawNote(g, w, h, '48 kHz assumed')
    },
    [palette, zoom],
  )
  return <MeterShell canvasRef={ref} />
}

/* ── 2. Spectrum Analyzer — log-spaced bars ───────────────────────────── */

function SpectrumAnalyzer({ source, palette, zoom = 1 }: MeterProps): ReactElement {
  const ref = useMeterCanvas(
    source,
    (g, w, h, frame) => {
      const lut = lutFor(palette)
      if (!frame || frame.frequencyData.length === 0) {
        drawPlaceholder(g, w, h, ['No live audio frame'])
        return
      }
      const { hz: sr } = sampleRateOf(frame)
      const fftSize = frame.frequencyData.length * 2
      const binHz = sr / fftSize
      const maxFreq = 20000 / Math.max(0.5, zoom)
      const edges = logBandEdges(frame.frequencyData.length, 48)
      const bands = aggregateBands(frame.frequencyData, edges)
      const visible: Array<{ value: number; centreHz: number }> = []
      for (let i = 0; i < bands.length; i++) {
        const [start, end] = edges[i]!
        const centreHz = Math.sqrt(start * binHz * end * binHz)
        if (centreHz <= maxFreq) visible.push({ value: bands[i]!, centreHz })
      }
      const gap = 2
      const barWidth = Math.max(1, (w - (visible.length - 1) * gap) / Math.max(1, visible.length))
      visible.forEach(({ value }, i) => {
        const barHeight = Math.max(value > 0 ? 2 : 0, value * (h - 20))
        if (barHeight <= 0) return
        const [r, gg, b] = lutColor(lut, value * 255)
        g.fillStyle = `rgb(${r}, ${gg}, ${b})`
        g.fillRect(i * (barWidth + gap), h - 16 - barHeight, barWidth, barHeight)
      })
      g.fillStyle = AURA.muted
      g.font = '10px sans-serif'
      g.fillText('20', 2, h - 4)
      g.fillText(formatHz(maxFreq), w - 28, h - 4)
    },
    [palette, zoom],
  )
  return <MeterShell canvasRef={ref} />
}

/* ── 3. Octave Analyzer — 1/1 or 1/3 octave bands ──────────────────────── */

function OctaveAnalyzer({ source, palette, zoom = 1 }: MeterProps): ReactElement {
  const [fraction, setFraction] = useState<1 | 3>(1)
  const ref = useMeterCanvas(
    source,
    (g, w, h, frame) => {
      const lut = lutFor(palette)
      if (!frame || frame.frequencyData.length === 0) {
        drawPlaceholder(g, w, h, ['No live audio frame'])
        return
      }
      const { hz: sr, assumed } = sampleRateOf(frame)
      const fftSize = frame.frequencyData.length * 2
      const bands = octaveBandEdges(fftSize, sr, fraction)
      const maxFreq = 20000 / Math.max(0.5, zoom)
      const shown = bands.filter((b) => b.centreHz <= maxFreq)
      if (shown.length < 3) {
        drawPlaceholder(g, w, h, [
          `FFT resolution too low for octave bands (fftSize=${fftSize})`,
          'Raise the visualizer fftSize to see the full octave range.',
        ])
        return
      }
      const values = aggregateOctaveBands(frame.frequencyData, shown)
      const gap = 3
      const barWidth = Math.max(1, (w - (shown.length - 1) * gap) / shown.length)
      shown.forEach((band, i) => {
        const value = values[i]!
        const barHeight = Math.max(value > 0 ? 2 : 0, value * (h - 32))
        const [r, gg, b] = lutColor(lut, value * 255)
        g.fillStyle = `rgb(${r}, ${gg}, ${b})`
        g.fillRect(i * (barWidth + gap), h - 28 - barHeight, barWidth, barHeight)
      })
      g.fillStyle = AURA.muted
      g.font = '10px sans-serif'
      const labelEvery = fraction === 1 ? 1 : 3
      shown.forEach((band, i) => {
        if (i % labelEvery !== 0) return
        const label = formatHz(band.centreHz)
        g.fillText(label, i * (barWidth + gap), h - 16)
      })
      g.fillText(`fftSize=${fftSize}${assumed ? ' · 48 kHz assumed' : ''}`, 2, 12)
    },
    [palette, zoom, fraction],
  )
  return (
    <MeterShell
      canvasRef={ref}
      children={
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, padding: '2px 0' }}>
          <button
            onClick={() => setFraction(1)}
            style={{ cursor: 'pointer', fontWeight: fraction === 1 ? 700 : 400 }}
          >
            1/1 octave
          </button>
          <button
            onClick={() => setFraction(3)}
            style={{ cursor: 'pointer', fontWeight: fraction === 3 ? 700 : 400 }}
          >
            1/3 octave
          </button>
        </div>
      }
    />
  )
}

/* ── 4. Oscilloscope — latest frame, channels overlaid ─────────────────── */

function Oscilloscope({ source, zoom = 1 }: MeterProps): ReactElement {
  const ref = useMeterCanvas(
    source,
    (g, w, h, frame) => {
      if (!frame) {
        drawPlaceholder(g, w, h, ['No live audio frame'])
        return
      }
      const { hz: sr, assumed } = sampleRateOf(frame)
      const traces: Array<{ samples: Float32Array; color: string; label: string }> = []
      if (frame.channels === 2 && frame.left && frame.right) {
        traces.push(
          { samples: samplesFromBytes(frame.left.timeDomainData), color: AURA.leftTrace, label: 'L' },
          { samples: samplesFromBytes(frame.right.timeDomainData), color: AURA.rightTrace, label: 'R' },
        )
      } else {
        traces.push(
          { samples: samplesFromBytes(frame.timeDomainData), color: AURA.leftTrace, label: 'mono' },
        )
      }
      const midY = h / 2
      gridLines(g, w, h, [w / 4, w / 2, (3 * w) / 4], [h / 4, midY, (3 * h) / 4])
      g.strokeStyle = AURA.gridStrong
      g.beginPath()
      g.moveTo(0, midY)
      g.lineTo(w, midY)
      g.stroke()
      const visibleMs = (traces[0]!.samples.length / Math.max(0.5, zoom) / sr) * 1000
      for (const trace of traces) {
        const count = Math.max(2, Math.floor(trace.samples.length / Math.max(0.5, zoom)))
        g.strokeStyle = trace.color
        g.lineWidth = 1.5
        g.beginPath()
        for (let i = 0; i < count; i++) {
          const x = (i / (count - 1)) * w
          const y = midY - trace.samples[i]! * (h / 2 - 4)
          if (i === 0) g.moveTo(x, y)
          else g.lineTo(x, y)
        }
        g.stroke()
      }
      g.fillStyle = AURA.muted
      g.font = '10px sans-serif'
      g.fillText(traces.map((t) => t.label).join(' / '), 4, 12)
      g.fillText(`${visibleMs.toFixed(1)} ms window${assumed ? ' · 48 kHz assumed' : ''}`, 4, h - 4)
    },
    [zoom],
  )
  return <MeterShell canvasRef={ref} />
}

/* ── 5. Waveform — scrolling frame-stitched history ────────────────────── */

function Waveform({ source, zoom = 1 }: MeterProps): ReactElement {
  const monoHistory = useRef(new TimeHistory(48000))
  const leftHistory = useRef(new TimeHistory(48000))
  const rightHistory = useRef(new TimeHistory(48000))
  const ref = useMeterCanvas(
    source,
    (g, w, h, frame) => {
      if (!frame) {
        drawPlaceholder(g, w, h, ['No live audio frame'])
        return
      }
      const { assumed } = sampleRateOf(frame)
      const stereo = frame.channels === 2 && frame.left && frame.right
      if (stereo) {
        leftHistory.current.pushBytes(frame.left!.timeDomainData)
        rightHistory.current.pushBytes(frame.right!.timeDomainData)
      } else {
        monoHistory.current.pushBytes(frame.timeDomainData)
      }
      const drawTrace = (samples: Float32Array, top: number, height: number, color: string) => {
        const window = Math.max(2, Math.floor(samples.length / Math.max(0.5, zoom)))
        const slice = samples.subarray(samples.length - window)
        const midY = top + height / 2
        g.strokeStyle = AURA.gridStrong
        g.beginPath()
        g.moveTo(0, midY)
        g.lineTo(w, midY)
        g.stroke()
        g.strokeStyle = color
        g.lineWidth = 1.2
        g.beginPath()
        for (let i = 0; i < slice.length; i++) {
          const x = (i / (slice.length - 1)) * w
          const y = midY - slice[i]! * (height / 2 - 2)
          if (i === 0) g.moveTo(x, y)
          else g.lineTo(x, y)
        }
        g.stroke()
      }
      if (stereo) {
        drawTrace(leftHistory.current.snapshot(), 0, h / 2, AURA.leftTrace)
        drawTrace(rightHistory.current.snapshot(), h / 2, h / 2, AURA.rightTrace)
      } else {
        drawTrace(monoHistory.current.snapshot(), 0, h, AURA.leftTrace)
      }
      drawNote(g, w, h, `frame-stitched history${assumed ? ' · 48 kHz assumed' : ''}`)
    },
    [zoom],
  )
  return <MeterShell canvasRef={ref} />
}

/* ── 6. Spectrogram — scrolling log-frequency waterfall ────────────────── */

const SPECTROGRAM_ROWS = 64
const SPECTROGRAM_COLUMNS = 240

function Spectrogram({ source, palette, zoom = 1 }: MeterProps): ReactElement {
  const waterfallRef = useRef<WaterfallBuffer | null>(null)
  const stripRef = useRef<HTMLCanvasElement | null>(null)
  const ref = useMeterCanvas(
    source,
    (g, w, h, frame) => {
      const lut = lutFor(palette)
      if (!frame || frame.frequencyData.length === 0) {
        drawPlaceholder(g, w, h, ['No live audio frame'])
        return
      }
      const { hz: sr } = sampleRateOf(frame)
      const fftSize = frame.frequencyData.length * 2
      const binHz = sr / fftSize
      if (!waterfallRef.current) {
        waterfallRef.current = new WaterfallBuffer(SPECTROGRAM_COLUMNS, SPECTROGRAM_ROWS)
      }
      const waterfall = waterfallRef.current
      waterfall.push(resampleToLogRows(frame.frequencyData, SPECTROGRAM_ROWS))
      if (!stripRef.current && typeof document !== 'undefined') {
        stripRef.current = document.createElement('canvas')
      }
      const strip = stripRef.current
      const stripCtx = strip?.getContext('2d') ?? null
      if (!strip || !stripCtx) return
      const maxFreq = 20000 / Math.max(0.5, zoom)
      // Log rows whose centre frequency is inside the zoomed range.
      let visibleRows = SPECTROGRAM_ROWS
      for (let row = 0; row < SPECTROGRAM_ROWS; row++) {
        const centreBin = Math.exp(Math.log(1) + Math.log(frame.frequencyData.length) * ((row + 0.5) / SPECTROGRAM_ROWS))
        if (centreBin * binHz > maxFreq) {
          visibleRows = row
          break
        }
      }
      visibleRows = Math.max(8, visibleRows)
      if (strip.width !== SPECTROGRAM_COLUMNS || strip.height !== visibleRows) {
        strip.width = SPECTROGRAM_COLUMNS
        strip.height = visibleRows
      }
      const image = stripCtx.createImageData(strip.width, strip.height)
      for (let x = 0; x < strip.width; x++) {
        const column = waterfall.columnAtAge(strip.width - 1 - x)
        for (let row = 0; row < visibleRows; row++) {
          const imageRow = visibleRows - 1 - row
          const offset = (imageRow * strip.width + x) * 4
          const value = column ? (column[row] ?? 0) : 0
          const [r, gg, b] = lutColor(lut, value)
          image.data[offset] = r
          image.data[offset + 1] = gg
          image.data[offset + 2] = b
          image.data[offset + 3] = 255
        }
      }
      stripCtx.putImageData(image, 0, 0)
      g.imageSmoothingEnabled = true
      g.drawImage(strip, 0, 0, w, h)
      g.fillStyle = AURA.text
      g.font = '10px sans-serif'
      g.fillText('20 Hz', 2, h - 4)
      g.fillText(formatHz(maxFreq), 2, 12)
    },
    [palette, zoom],
  )
  return <MeterShell canvasRef={ref} />
}

/* ── 7. XY Scope — Lissajous (stereo only) ─────────────────────────────── */

const STEREO_PLACEHOLDER = [
  'Needs stereo data — this source is mono.',
  'See README “Stereo data: what audio-engine must change”.',
]

function XyScope({ source }: MeterProps): ReactElement {
  const ref = useMeterCanvas(
    source,
    (g, w, h, frame) => {
      if (!frame || frame.channels !== 2 || !frame.left || !frame.right) {
        drawPlaceholder(g, w, h, STEREO_PLACEHOLDER)
        return
      }
      const left = samplesFromBytes(frame.left.timeDomainData)
      const right = samplesFromBytes(frame.right.timeDomainData)
      const levels = computeStereoLevels(left, right)
      const cx = w / 2
      const cy = h / 2
      const radius = Math.min(w, h) / 2 - 14
      gridLines(g, w, h, [cx], [cy])
      g.strokeStyle = AURA.gridStrong
      g.beginPath()
      g.arc(cx, cy, radius, 0, Math.PI * 2)
      g.stroke()
      // Diagonal guides: L axis and R axis of a goniometer.
      g.beginPath()
      g.moveTo(cx - radius * 0.707, cy - radius * 0.707)
      g.lineTo(cx + radius * 0.707, cy + radius * 0.707)
      g.moveTo(cx + radius * 0.707, cy - radius * 0.707)
      g.lineTo(cx - radius * 0.707, cy + radius * 0.707)
      g.stroke()
      const n = Math.min(left.length, right.length)
      g.strokeStyle = AURA.accent
      g.lineWidth = 1.2
      g.beginPath()
      for (let i = 0; i < n; i++) {
        const l = left[i]!
        const r = right[i]!
        const x = cx + (l - r) * 0.707 * radius
        const y = cy - (l + r) * 0.707 * radius
        if (i === 0) g.moveTo(x, y)
        else g.lineTo(x, y)
      }
      g.stroke()
      g.fillStyle = AURA.muted
      g.font = '11px sans-serif'
      g.fillText(`corr ${levels.correlation.toFixed(2)}  width ${(levels.width * 100).toFixed(0)}%`, 4, 14)
    },
    [],
  )
  return <MeterShell canvasRef={ref} />
}

/* ── 8. Stereo Level Meter — per-channel RMS + peak (stereo only) ─────── */

function StereoLevel({ source, palette }: MeterProps): ReactElement {
  const leftVu = useRef<VuState>(createVuState())
  const rightVu = useRef<VuState>(createVuState())
  const ref = useMeterCanvas(
    source,
    (g, w, h, frame) => {
      const lut = lutFor(palette)
      if (!frame || frame.channels !== 2 || !frame.left || !frame.right) {
        drawPlaceholder(g, w, h, STEREO_PLACEHOLDER)
        return
      }
      const left = samplesFromBytes(frame.left.timeDomainData)
      const right = samplesFromBytes(frame.right.timeDomainData)
      const levels = computeStereoLevels(left, right)
      leftVu.current = stepVu(leftVu.current, levels.leftRmsDb, levels.leftPeakDb)
      rightVu.current = stepVu(rightVu.current, levels.rightRmsDb, levels.rightPeakDb)
      const drawBar = (x: number, barW: number, vu: VuState, label: string) => {
        g.fillStyle = AURA.track
        g.fillRect(x, 16, barW, h - 32)
        const frac = dbToFraction(vu.levelDb)
        if (frac > 0) {
          const [r, gg, b] = lutColor(lut, frac * 255)
          g.fillStyle = `rgb(${r}, ${gg}, ${b})`
          g.fillRect(x, 16 + (1 - frac) * (h - 32), barW, frac * (h - 32))
        }
        const peakY = 16 + (1 - dbToFraction(vu.peakDb)) * (h - 32)
        g.fillStyle = AURA.peak
        g.fillRect(x - 2, peakY - 1, barW + 4, 2)
        g.fillStyle = AURA.muted
        g.font = '11px sans-serif'
        g.fillText(label, x, h - 4)
        g.fillText(`${vu.levelDb <= DB_FLOOR ? '-∞' : vu.levelDb.toFixed(1)} dB`, x, 12)
      }
      const barW = Math.max(16, (w - 60) / 2)
      drawBar(20, barW, leftVu.current, 'L')
      drawBar(40 + barW, barW, rightVu.current, 'R')
      g.fillStyle = AURA.muted
      g.font = '10px sans-serif'
      for (const db of [-60, -30, 0]) {
        g.fillText(`${db}`, w - 22, 16 + (1 - dbToFraction(db)) * (h - 32) + 3)
      }
    },
    [palette],
  )
  return <MeterShell canvasRef={ref} />
}

/* ── 9. Loudness Meter — momentary / short-term / integrated ──────────── */

function Loudness({ source }: MeterProps): ReactElement {
  const stateRef = useRef<LoudnessState>(createLoudnessState())
  const lastStepRef = useRef(0)
  const ref = useMeterCanvas(
    source,
    (g, w, h, frame) => {
      if (!frame) {
        drawPlaceholder(g, w, h, ['No live audio frame'])
        return
      }
      // Decimate to ~10 Hz: the τ windows are time-based, so stepping
      // every animation frame would only waste history entries.
      if (frame.timestampMs - lastStepRef.current >= 100 || lastStepRef.current === 0) {
        const rms = computeRms(frame.timeDomainData)
        const dtMs = lastStepRef.current === 0 ? 100 : frame.timestampMs - lastStepRef.current
        stateRef.current = stepLoudness(stateRef.current, rms, dtMs)
        lastStepRef.current = frame.timestampMs
      }
      const state = stateRef.current
      const fmt = (v: number) => (v <= -70 ? '-∞' : v.toFixed(1))
      // AURA loudness: the integrated value is the hero number, the
      // rest are supporting readouts underneath it.
      g.fillStyle = AURA.text
      g.font = '700 30px sans-serif'
      g.fillText(`${fmt(state.integratedLu)}`, 8, 36)
      g.font = '12px sans-serif'
      g.fillStyle = AURA.muted
      g.fillText('LUFS  Integrated', 8, 54)
      g.fillText(`Short-term  ${fmt(state.shortTermLu)} LUFS`, 8, 72)
      g.fillText(`Momentary  ${fmt(state.momentaryLu)} LUFS`, 8, 88)
      g.fillText(`LRA (windowed)  ${state.lraLu.toFixed(1)} LU`, 8, 104)
      // Short-term history trace.
      const traceTop = 118
      const traceH = Math.max(20, h - traceTop - 28)
      gridLines(g, w, h, [], [traceTop + traceH / 2])
      g.strokeStyle = AURA.accent
      g.lineWidth = 1.2
      g.beginPath()
      state.shortHistory.forEach((lu, i) => {
        const x = (i / Math.max(1, state.shortHistory.length - 1)) * w
        const t = (lu + 70) / 70
        const y = traceTop + (1 - Math.min(1, Math.max(0, t))) * traceH
        if (i === 0) g.moveTo(x, y)
        else g.lineTo(x, y)
      })
      g.stroke()
      drawNote(g, w, h, 'approx: no K-weighting, mono byte data')
    },
    [],
  )
  return <MeterShell canvasRef={ref} />
}

/* ── 10. Stereo Field — goniometer (stereo only) ───────────────────────── */

function StereoField({ source }: MeterProps): ReactElement {
  const ref = useMeterCanvas(
    source,
    (g, w, h, frame) => {
      if (!frame || frame.channels !== 2 || !frame.left || !frame.right) {
        drawPlaceholder(g, w, h, STEREO_PLACEHOLDER)
        return
      }
      const left = samplesFromBytes(frame.left.timeDomainData)
      const right = samplesFromBytes(frame.right.timeDomainData)
      const levels = computeStereoLevels(left, right)
      const cx = w / 2
      const cy = (h - 30) / 2 + 10
      const radius = Math.min(w, h - 30) / 2 - 10
      g.strokeStyle = AURA.gridStrong
      g.beginPath()
      g.arc(cx, cy, radius, 0, Math.PI * 2)
      g.stroke()
      g.beginPath()
      g.moveTo(cx, cy - radius)
      g.lineTo(cx, cy + radius)
      g.moveTo(cx - radius, cy)
      g.lineTo(cx + radius, cy)
      g.stroke()
      // Mid vertical, side horizontal: mono = vertical line, out of
      // phase = horizontal line. Dots, not a polyline: the field is a
      // cloud, and connecting samples in time order would draw chords
      // the field does not contain.
      g.fillStyle = AURA.accentSoft
      const n = Math.min(left.length, right.length)
      for (let i = 0; i < n; i++) {
        const l = left[i]!
        const r = right[i]!
        const x = cx + ((l - r) / 2) * radius * 1.414
        const y = cy - ((l + r) / 2) * radius * 1.414
        g.fillRect(x, y, 1.5, 1.5)
      }
      g.fillStyle = AURA.muted
      g.font = '11px sans-serif'
      g.fillText(`width ${(levels.width * 100).toFixed(0)}%  corr ${levels.correlation.toFixed(2)}`, 4, 14)
      g.fillText('mid ↑  side →', 4, h - 4)
    },
    [],
  )
  return <MeterShell canvasRef={ref} />
}

/* ── Composition: kind → component ─────────────────────────────────────── */

export function MeterCanvas({
  kind,
  source,
  palette,
  zoom,
}: MeterProps & { kind: MeterKind }): ReactElement {
  switch (kind) {
    case 'fft-analyzer':
      return <FftAnalyzer source={source} palette={palette} zoom={zoom} />
    case 'oscilloscope':
      return <Oscilloscope source={source} palette={palette} zoom={zoom} />
    case 'octave-analyzer':
      return <OctaveAnalyzer source={source} palette={palette} zoom={zoom} />
    case 'spectrogram':
      return <Spectrogram source={source} palette={palette} zoom={zoom} />
    case 'xy-scope':
      return <XyScope source={source} palette={palette} zoom={zoom} />
    case 'spectrum-analyzer':
      return <SpectrumAnalyzer source={source} palette={palette} zoom={zoom} />
    case 'waveform':
      return <Waveform source={source} palette={palette} zoom={zoom} />
    case 'stereo-level':
      return <StereoLevel source={source} palette={palette} zoom={zoom} />
    case 'loudness':
      return <Loudness source={source} palette={palette} zoom={zoom} />
    case 'stereo-field':
      return <StereoField source={source} palette={palette} zoom={zoom} />
  }
}
