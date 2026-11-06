/**
 * meters.tsx — eleven independent meter components.
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
import type { CSSProperties, ReactElement, RefObject } from 'react'
import type { AudioFrame, FrameSource } from './audio-frame.js'
import { samplesFromBytes, TimeHistory } from './audio-frame.js'
import type { MetersPaletteName } from './config.js'
import {
  aggregateBands,
  aggregateOctaveBands,
  buildPaletteLut,
  byteToDb,
  columnEnvelope,
  computePeak,
  computeRms,
  computeStereoLevels,
  createLoudnessState,
  createVuState,
  dbToFraction,
  DB_FLOOR,
  HEAT_STOPS,
  levelToDb,
  logBandEdges,
  loudnessRange,
  lutColor,
  octaveBandEdges,
  PALETTE_STOPS,
  resampleToLogRows,
  smoothDisplayValue,
  stepLoudness,
  stepVu,
  WaterfallBuffer,
  type LoudnessState,
  type VuState,
} from './meters-math.js'
import type { MeterKind } from './workspace.js'
import { AURA, auraSmallButtonStyle } from './aura-theme.js'

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
 * Runs `draw` with a soft mint glow, then restores the context.
 * `shadowBlur` is expensive, so it is used only for the one live
 * trace per meter — never for grids, dots, or fills.
 */
function withGlow(
  g: CanvasRenderingContext2D,
  color: string,
  blur: number,
  draw: () => void,
): void {
  g.save()
  g.shadowColor = color
  g.shadowBlur = blur
  draw()
  g.restore()
}

/**
 * Polar grid for the stereo scopes: three concentric rings, the
 * cross axes, and the diagonal L/R guides. The scopes themselves
 * draw their trace on top; the grid is deliberately faint so the
 * live data stays the brightest thing on the card.
 */
function drawPolarGrid(
  g: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
): void {
  g.strokeStyle = AURA.grid
  g.lineWidth = 1
  g.beginPath()
  for (const f of [1 / 3, 2 / 3, 1]) {
    g.moveTo(cx + radius * f, cy)
    g.arc(cx, cy, radius * f, 0, Math.PI * 2)
  }
  g.stroke()
  g.strokeStyle = AURA.gridStrong
  g.beginPath()
  g.moveTo(cx, cy - radius)
  g.lineTo(cx, cy + radius)
  g.moveTo(cx - radius, cy)
  g.lineTo(cx + radius, cy)
  g.moveTo(cx - radius * 0.707, cy - radius * 0.707)
  g.lineTo(cx + radius * 0.707, cy + radius * 0.707)
  g.moveTo(cx + radius * 0.707, cy - radius * 0.707)
  g.lineTo(cx - radius * 0.707, cy + radius * 0.707)
  g.stroke()
}

/** Soft mint halo at a scope's centre, under the trace. */
function drawCentreHalo(
  g: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
): void {
  const halo = g.createRadialGradient(cx, cy, 0, cx, cy, radius)
  halo.addColorStop(0, 'rgba(127, 231, 196, 0.20)')
  halo.addColorStop(1, 'rgba(127, 231, 196, 0)')
  g.fillStyle = halo
  g.beginPath()
  g.arc(cx, cy, radius, 0, Math.PI * 2)
  g.fill()
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
  const displayRef = useRef<Float32Array | null>(null)
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
      if (!displayRef.current || displayRef.current.length !== frame.frequencyData.length) {
        displayRef.current = new Float32Array(frame.frequencyData.length)
      }
      const peak = peakRef.current
      const displayed = displayRef.current
      const [pr, pg, pb] = lutColor(lut, 255)
      // AURA fill: the mint gradient under the line, fading to the card.
      // The line itself is display-smoothed (attack instant, release
      // exponential); the peak line below still tracks the raw bytes.
      const points: Array<readonly [number, number]> = []
      for (let bin = 1; bin < frame.frequencyData.length; bin++) {
        const freq = bin * binHz
        if (freq < minFreq || freq > maxFreq) continue
        const value = frame.frequencyData[bin]!
        peak[bin] = Math.max(peak[bin]! - 0.5, value)
        displayed[bin] = smoothDisplayValue(displayed[bin]!, value)
        points.push([logX(freq), dbY(byteToDb(displayed[bin]!))] as const)
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
      withGlow(g, 'rgba(127, 231, 196, 0.55)', 6, () => {
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
      })
      g.strokeStyle = AURA.peakSoft
      g.lineWidth = 1
      g.beginPath()
      let started = false
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

/* ── 2. Spectrum Analyzer — smoothed log-band line ──────────────────────
 *
 * The reference figure draws this meter as one continuous mint line
 * with a gradient fill underneath — not bars. The data is unchanged:
 * the same 48 log-spaced bands (band maximum, as before), display-
 * smoothed the same way; only the presentation changed from bars to
 * the line the figure shows. The per-band peak-hold survives as the
 * thin warm line above the live line, and the card's Peak readout is
 * the time-domain peak (same value the level meter reports), drawn
 * top-right like the figure. The dB scale is the byte convention's
 * own −100…−30 dB range, shared with the FFT analyzer — the figure's
 * 0/−24/−48/−72 ticks would need a 0 dBFS byte that does not exist.
 */

function SpectrumAnalyzer({ source, palette, zoom = 1 }: MeterProps): ReactElement {
  const displayRef = useRef<Float32Array | null>(null)
  const peakRef = useRef<Float32Array | null>(null)
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
      const minFreq = 20
      const edges = logBandEdges(frame.frequencyData.length, 48)
      const bands = aggregateBands(frame.frequencyData, edges)
      const visible: Array<{ value: number; centreHz: number }> = []
      for (let i = 0; i < bands.length; i++) {
        const [start, end] = edges[i]!
        const centreHz = Math.sqrt(start * binHz * end * binHz)
        if (centreHz <= maxFreq) visible.push({ value: bands[i]!, centreHz })
      }
      if (!displayRef.current || displayRef.current.length !== visible.length) {
        displayRef.current = new Float32Array(visible.length)
      }
      if (!peakRef.current || peakRef.current.length !== visible.length) {
        peakRef.current = new Float32Array(visible.length)
      }
      const displayed = displayRef.current
      const peak = peakRef.current
      visible.forEach((band, i) => {
        displayed[i] = smoothDisplayValue(displayed[i]!, band.value)
        peak[i] = Math.max(peak[i]! - 0.01, band.value)
      })
      const logX = (freq: number) =>
        ((Math.log(Math.max(minFreq, freq)) - Math.log(minFreq)) /
          (Math.log(maxFreq) - Math.log(minFreq))) * w
      const dbY = (db: number) => h - 14 - ((db + 100) / 70) * (h - 28)
      gridLines(
        g,
        w,
        h,
        [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
          .filter((f) => f >= minFreq && f <= maxFreq)
          .map(logX),
        [-90, -60, -30].map(dbY),
      )
      const points: Array<readonly [number, number]> = visible.map((band, i) => [
        logX(band.centreHz),
        dbY(byteToDb(displayed[i]! * 255)),
      ])
      if (points.length > 1) {
        const fill = g.createLinearGradient(0, 0, 0, h)
        fill.addColorStop(0, 'rgba(127, 231, 196, 0.30)')
        fill.addColorStop(1, 'rgba(127, 231, 196, 0)')
        g.fillStyle = fill
        g.beginPath()
        g.moveTo(points[0]![0], h - 14)
        for (const [x, y] of points) g.lineTo(x, y)
        g.lineTo(points[points.length - 1]![0], h - 14)
        g.closePath()
        g.fill()
      }
      const [pr, pg, pb] = lutColor(lut, 255)
      withGlow(g, 'rgba(127, 231, 196, 0.55)', 6, () => {
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
      })
      // Peak-hold line: the raw band maxima, decaying slowly.
      g.strokeStyle = AURA.peakSoft
      g.lineWidth = 1
      g.beginPath()
      let started = false
      for (let i = 0; i < visible.length; i++) {
        const x = logX(visible[i]!.centreHz)
        const y = dbY(byteToDb(peak[i]! * 255))
        if (!started) {
          g.moveTo(x, y)
          started = true
        } else g.lineTo(x, y)
      }
      g.stroke()
      g.fillStyle = AURA.muted
      g.font = '10px sans-serif'
      for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
        if (f < minFreq || f > maxFreq) continue
        g.fillText(formatHz(f), Math.min(w - 24, logX(f) + 2), h - 4)
      }
      for (const db of [-90, -60, -30]) g.fillText(`${db}`, 2, dbY(db) - 2)
      // Peak readout, top-right like the reference: the time-domain
      // peak of this frame (same definition the level meter uses).
      const framePeak = computePeak(frame.timeDomainData)
      const peakLabel = framePeak <= 0 ? '-∞' : levelToDb(framePeak).toFixed(1)
      g.font = '11px sans-serif'
      g.fillStyle = AURA.muted
      g.textAlign = 'right'
      g.fillText(`Peak ${peakLabel} dB`, w - 14, 12)
      g.fillStyle = AURA.peak
      g.beginPath()
      g.arc(w - 6, 9, 3, 0, Math.PI * 2)
      g.fill()
      g.textAlign = 'left'
    },
    [palette, zoom],
  )
  return <MeterShell canvasRef={ref} />
}

/* ── 3. Octave Analyzer — 1/1 or 1/3 octave bands ──────────────────────── */

function OctaveAnalyzer({ source, palette, zoom = 1 }: MeterProps): ReactElement {
  const [fraction, setFraction] = useState<1 | 3>(1)
  const displayRef = useRef<Float32Array | null>(null)
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
      if (!displayRef.current || displayRef.current.length !== shown.length) {
        displayRef.current = new Float32Array(shown.length)
      }
      const displayed = displayRef.current
      shown.forEach((_band, i) => {
        displayed[i] = smoothDisplayValue(displayed[i]!, values[i]!)
      })
      const gap = 3
      const barWidth = Math.max(1, (w - (shown.length - 1) * gap) / shown.length)
      gridLines(g, w, h, [], [h - 28 - (h - 32) * 0.25, h - 28 - (h - 32) * 0.5, h - 28 - (h - 32) * 0.75])
      shown.forEach((_band, i) => {
        const value = displayed[i]!
        const barHeight = Math.max(value > 0 ? 2 : 0, value * (h - 32))
        const [r, gg, b] = lutColor(lut, value * 255)
        const grad = g.createLinearGradient(0, h - 28 - barHeight, 0, h - 28)
        grad.addColorStop(0, `rgb(${r}, ${gg}, ${b})`)
        grad.addColorStop(1, `rgba(${Math.round(r * 0.3)}, ${Math.round(gg * 0.3)}, ${Math.round(b * 0.3)}, 0.9)`)
        g.fillStyle = grad
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
  const toggleStyle = (active: boolean): CSSProperties => ({
    ...auraSmallButtonStyle,
    fontWeight: active ? 700 : 400,
    background: active ? AURA.accentFaint : auraSmallButtonStyle.background,
    color: active ? AURA.accent : auraSmallButtonStyle.color,
    borderColor: active ? 'rgba(127, 231, 196, 0.45)' : auraSmallButtonStyle.borderColor,
  })
  return (
    <MeterShell
      canvasRef={ref}
      children={
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, padding: '2px 0' }}>
          <button onClick={() => setFraction(1)} style={toggleStyle(fraction === 1)}>
            1/1 octave
          </button>
          <button onClick={() => setFraction(3)} style={toggleStyle(fraction === 3)}>
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
        withGlow(g, trace.color, 6, () => {
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
        })
      }
      g.fillStyle = AURA.muted
      g.font = '10px sans-serif'
      g.fillText(traces.map((t) => t.label).join(' / '), 4, 12)
      // Time axis: 0 at the left edge, half and full window at the
      // quarter gridlines already drawn above.
      g.fillText('0', 4, h - 4)
      g.fillText(`${(visibleMs / 2).toFixed(1)} ms`, w / 2 - 18, h - 4)
      g.fillText(`${visibleMs.toFixed(1)} ms`, w - 52, h - 4)
      if (assumed) drawNote(g, w, h, '48 kHz assumed')
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
      const { hz: sr, assumed } = sampleRateOf(frame)
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
        const half = height / 2 - 2
        g.strokeStyle = AURA.gridStrong
        g.beginPath()
        g.moveTo(0, midY)
        g.lineTo(w, midY)
        g.stroke()
        // DAW-style envelope: one min…max band per pixel column (see
        // `columnEnvelope` — every sample reaches its column's edge).
        // A 1 s window of a 440 Hz sine is ~440 cycles across the card,
        // so a sample-by-sample polyline overdraws into a solid bar;
        // the envelope band is the same data, drawn the way the
        // reference figure draws it: translucent fill, bright centre.
        const columns = Math.max(2, Math.floor(w))
        const envelope = columnEnvelope(slice, columns)
        const colW = w / columns
        g.fillStyle = 'rgba(127, 231, 196, 0.22)'
        g.beginPath()
        let first = true
        for (let c = 0; c < envelope.length; c++) {
          const x = c * colW
          const yTop = midY - envelope[c]!.max * half
          if (first) {
            g.moveTo(x, yTop)
            first = false
          } else g.lineTo(x, yTop)
        }
        for (let c = envelope.length - 1; c >= 0; c--) {
          const x = c * colW
          g.lineTo(x, midY - envelope[c]!.min * half)
        }
        g.closePath()
        g.fill()
        withGlow(g, color, 5, () => {
          g.strokeStyle = color
          g.lineWidth = 1.2
          g.beginPath()
          for (let c = 0; c < envelope.length; c++) {
            const x = c * colW + colW / 2
            const y = midY - envelope[c]!.mean * half
            if (c === 0) g.moveTo(x, y)
            else g.lineTo(x, y)
          }
          g.stroke()
        })
        return slice.length
      }
      let shownSamples = 0
      if (stereo) {
        shownSamples = drawTrace(leftHistory.current.snapshot(), 0, h / 2, AURA.leftTrace)
        drawTrace(rightHistory.current.snapshot(), h / 2, h / 2, AURA.rightTrace)
      } else {
        shownSamples = drawTrace(monoHistory.current.snapshot(), 0, h, AURA.leftTrace)
      }
      // The history window in seconds: the ring holds 48000 samples
      // (1 s at 48 kHz), so the window is the filled length, not a
      // fixed label. See audio-frame.ts for why this stays approximate.
      drawNote(
        g,
        w,
        h,
        `frame-stitched · ${(shownSamples / sr).toFixed(1)} s${assumed ? ' · 48 kHz assumed' : ''}`,
      )
    },
    [zoom],
  )
  return <MeterShell canvasRef={ref} />
}

/* ── 6. Spectrogram — scrolling log-frequency waterfall ────────────────── */

const SPECTROGRAM_ROWS = 64
const SPECTROGRAM_COLUMNS = 240

const heatLut = buildPaletteLut(HEAT_STOPS)

function Spectrogram({ source, palette, zoom = 1 }: MeterProps): ReactElement {
  const waterfallRef = useRef<WaterfallBuffer | null>(null)
  const stripRef = useRef<HTMLCanvasElement | null>(null)
  // Push timestamps, oldest → newest, parallel to the waterfall
  // columns: the time axis is drawn from real elapsed time, not from
  // an assumed frame rate (60 Hz panels and 120 Hz panels would
  // otherwise label the same strip with different windows).
  const timeRef = useRef<number[]>([])
  const ref = useMeterCanvas(
    source,
    (g, w, h, frame) => {
      // Heat scale by design (see HEAT_STOPS); the workspace palette
      // still drives the other meters.
      void palette
      const lut = heatLut
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
      const times = timeRef.current
      times.push(typeof performance !== 'undefined' ? performance.now() : Date.now())
      while (times.length > SPECTROGRAM_COLUMNS) times.shift()
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
      // Plot rect with real axes: frequency labels on the left, time
      // along the bottom, like the reference. The strip itself is
      // drawn inside the rect only — labels no longer sit on the heat.
      const plotLeft = 30
      const plotTop = 4
      const plotRight = w - 4
      const plotBottom = h - 16
      const plotW = Math.max(1, plotRight - plotLeft)
      const plotH = Math.max(1, plotBottom - plotTop)
      g.imageSmoothingEnabled = true
      g.drawImage(strip, plotLeft, plotTop, plotW, plotH)
      // Frequency axis (left edge): log positions for 200 / 1k / 5k /
      // 20k, from the same log-row mapping the waterfall uses.
      const binCount = frame.frequencyData.length
      g.fillStyle = AURA.muted
      g.font = '10px sans-serif'
      for (const f of [200, 1000, 5000, 20000]) {
        if (f > maxFreq) continue
        const frac = Math.log(Math.max(1, f / binHz)) / Math.log(Math.max(2, binCount))
        const y = plotBottom - frac * plotH
        if (y < plotTop + 8 || y > plotBottom - 2) continue
        g.fillText(formatHz(f), 2, y + 3)
      }
      g.fillText('20 Hz', 2, plotBottom)
      // "Log" tag, top-right of the plot, as in the reference header.
      g.textAlign = 'right'
      g.fillText('Log', plotRight, plotTop + 10)
      g.textAlign = 'left'
      // Time axis (bottom edge): window-relative seconds from the real
      // push history — 0 s at the oldest column, the window span at
      // the newest — not an assumed frame rate.
      const stamps = timeRef.current
      if (stamps.length > 1) {
        const first = stamps[0]!
        const newest = stamps[stamps.length - 1]!
        const windowSec = (newest - first) / 1000
        if (windowSec >= 1) {
          g.fillStyle = AURA.muted
          g.textAlign = 'center'
          for (let s = 0; s <= Math.floor(windowSec); s++) {
            const x = plotLeft + (s / windowSec) * plotW
            if (x < plotLeft + 8 || x > plotRight - 8) continue
            g.fillText(`${s}s`, x, h - 4)
          }
          g.textAlign = 'left'
        }
      }
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
      drawPolarGrid(g, cx, cy, radius)
      drawCentreHalo(g, cx, cy, radius * 0.45)
      const n = Math.min(left.length, right.length)
      withGlow(g, 'rgba(127, 231, 196, 0.6)', 6, () => {
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
      })
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
      void lut
      void palette
      // Reference layout: thin segmented bars on the left with the dB
      // scale at the left edge, and the Peak / RMS readouts as a
      // right-hand column. Peak and RMS are the louder channel's
      // values (the bars still show each channel separately).
      const top = 16
      const trackH = h - 32
      const rightColX = w >= 320 ? w * 0.6 : w - 110
      const barsLeft = 34
      const barsRight = Math.max(barsLeft + 60, rightColX - 12)
      const slotW = (barsRight - barsLeft) / 2
      const barW = Math.min(30, slotW * 0.45)
      // Zone gradient over the full track height, so colours mean
      // absolute level (green → cyan → yellow → hot orange at the
      // top), not the height of the current bar.
      const zoneGrad = g.createLinearGradient(0, top + trackH, 0, top)
      zoneGrad.addColorStop(0, '#2fbf71')
      zoneGrad.addColorStop(0.6, '#5eead4')
      zoneGrad.addColorStop(0.82, '#facc15')
      zoneGrad.addColorStop(1, '#ff9a5c')
      const segDb = 3
      const segCount = 60 / segDb
      const segH = trackH / segCount
      const drawBar = (slot: 0 | 1, vu: VuState, label: string) => {
        const x = barsLeft + slot * slotW + (slotW - barW) / 2
        g.fillStyle = AURA.track
        g.fillRect(x, top, barW, trackH)
        // Segmented fill: 3 dB segments with a 2 px gap, so the bar
        // reads as the reference's stacked segments, not a solid block.
        g.fillStyle = zoneGrad
        for (let s = 0; s < segCount; s++) {
          const segLoDb = -60 + s * segDb
          const segHiDb = segLoDb + segDb
          if (vu.levelDb <= segLoDb) break
          const fillFrac = Math.min(1, (vu.levelDb - segLoDb) / segDb)
          const segTopY = top + trackH - (s + 1) * segH
          const segBotY = top + trackH - s * segH
          const drawTop = segBotY - fillFrac * (segBotY - segTopY)
          g.fillRect(x, drawTop + 1, barW, Math.max(0, segBotY - drawTop - 2))
          if (fillFrac < 1) break
        }
        const peakY = top + (1 - dbToFraction(vu.peakDb)) * trackH
        g.fillStyle = AURA.peak
        g.fillRect(x - 2, peakY - 1, barW + 4, 2)
        g.fillStyle = AURA.muted
        g.font = '11px sans-serif'
        g.textAlign = 'center'
        g.fillText(label, x + barW / 2, h - 4)
        g.textAlign = 'left'
      }
      drawBar(0, leftVu.current, 'L')
      drawBar(1, rightVu.current, 'R')
      g.fillStyle = AURA.muted
      g.font = '10px sans-serif'
      for (const db of [0, -6, -12, -24, -48]) {
        g.fillText(`${db}`, 2, top + (1 - dbToFraction(db)) * trackH + 3)
      }
      // Right-hand readouts: louder channel's peak and RMS.
      const peakDb = Math.max(leftVu.current.peakDb, rightVu.current.peakDb)
      const rmsDb = Math.max(leftVu.current.levelDb, rightVu.current.levelDb)
      const fmtDb = (db: number) => (db <= DB_FLOOR ? '-∞' : db.toFixed(1))
      g.fillStyle = AURA.muted
      g.font = '11px sans-serif'
      g.fillText('Peak', rightColX, top + 14)
      g.fillStyle = AURA.text
      g.font = '700 20px sans-serif'
      g.fillText(`${fmtDb(peakDb)} dB`, rightColX, top + 38)
      g.fillStyle = AURA.peak
      g.beginPath()
      g.arc(rightColX + g.measureText(`${fmtDb(peakDb)} dB`).width + 8, top + 31, 3, 0, Math.PI * 2)
      g.fill()
      g.fillStyle = AURA.muted
      g.font = '11px sans-serif'
      g.fillText('RMS', rightColX, top + 66)
      g.fillStyle = AURA.text
      g.font = '700 20px sans-serif'
      g.fillText(`${fmtDb(rmsDb)} dB`, rightColX, top + 90)
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
      // Reference layout: the integrated value is the hero number in a
      // left column (big value, then Short-term / Momentary / LRA
      // rows), the short-term history is a chart in the right column,
      // and the segmented −60…0 bar underneath it carries the LRA
      // span and the integrated tick. Same data as before — same
      // loudness state, same history, same [p10, p95] range — only
      // the arrangement changed. (The approximation note now lives in
      // the dashboard's About drawer instead of on the canvas.)
      const twoCol = w >= 360
      const leftW = twoCol ? Math.max(150, Math.floor(w * 0.42)) : w
      const rightX = leftW + 10
      const rightW = Math.max(0, w - rightX - 8)
      g.fillStyle = AURA.text
      g.font = '700 32px sans-serif'
      const intText = fmt(state.integratedLu)
      g.fillText(intText, 8, 40)
      const intW = g.measureText(intText).width
      g.font = '13px sans-serif'
      g.fillStyle = AURA.muted
      g.fillText('LUFS', 8 + intW + 6, 40)
      g.font = '12px sans-serif'
      g.fillText('Integrated', 8, 60)
      const rows: Array<[string, string]> = [
        [fmt(state.shortTermLu), 'Short-term'],
        [fmt(state.momentaryLu), 'Momentary'],
        [state.lraLu.toFixed(1), 'LRA'],
      ]
      rows.forEach(([value, label], i) => {
        const y = 82 + i * 20
        g.fillStyle = AURA.text
        g.font = '700 14px sans-serif'
        g.fillText(value, 8, y)
        g.fillStyle = AURA.muted
        g.font = '12px sans-serif'
        g.fillText(label, 8 + 58, y)
      })
      // Short-term history chart.
      const histX = twoCol ? rightX : 8
      const histW = twoCol ? rightW : w - 16
      const histTop = twoCol ? 8 : 132
      const histH = twoCol ? 118 : Math.max(40, h - histTop - 64)
      const luY = (lu: number) =>
        histTop + (1 - Math.min(1, Math.max(0, (lu + 70) / 70))) * histH
      g.strokeStyle = AURA.grid
      g.lineWidth = 1
      g.beginPath()
      for (const lu of [-60, -40, -20]) {
        g.moveTo(histX, luY(lu))
        g.lineTo(histX + histW, luY(lu))
      }
      g.stroke()
      g.strokeRect(histX + 0.5, histTop + 0.5, histW - 1, histH - 1)
      withGlow(g, 'rgba(127, 231, 196, 0.5)', 4, () => {
        g.strokeStyle = AURA.accent
        g.lineWidth = 1.2
        g.beginPath()
        state.shortHistory.forEach((lu, i) => {
          const x = histX + (i / Math.max(1, state.shortHistory.length - 1)) * histW
          const y = luY(lu)
          if (i === 0) g.moveTo(x, y)
          else g.lineTo(x, y)
        })
        g.stroke()
      })
      // Segmented −60…0 bar: zone colours like the reference, the LRA
      // [p10, p95] span as an accent overlay, white tick at integrated.
      const barX = histX
      const barW = histW
      const barY = histTop + histH + 12
      const barH = 10
      const range = loudnessRange(state.shortHistory)
      const luX60 = (lu: number) => barX + ((lu + 60) / 60) * barW
      const segCount = 12
      const segW = barW / segCount
      for (let s = 0; s < segCount; s++) {
        const lo = -60 + s * 5
        g.fillStyle =
          lo < -36 ? '#5eead4' : lo < -24 ? '#8ff5d2' : lo < -12 ? '#f5d9a0' : 'rgba(255, 255, 255, 0.18)'
        g.fillRect(barX + s * segW + 1, barY, Math.max(0, segW - 2), barH)
      }
      if (range) {
        g.fillStyle = 'rgba(127, 231, 196, 0.45)'
        g.fillRect(
          luX60(Math.max(-60, range.p10)),
          barY - 2,
          Math.max(2, luX60(Math.min(0, range.p95)) - luX60(Math.max(-60, range.p10))),
          barH + 4,
        )
      }
      g.fillStyle = AURA.text
      g.fillRect(luX60(Math.max(-60, Math.min(0, state.integratedLu))) - 1, barY - 2, 2, barH + 4)
      g.fillStyle = AURA.muted
      g.font = '9px sans-serif'
      g.textAlign = 'center'
      for (const tick of [-60, -48, -36, -24, -12, 0]) {
        const x = Math.min(barX + barW - 6, Math.max(barX + 6, luX60(tick)))
        g.fillText(`${tick}`, x, barY + barH + 11)
      }
      g.textAlign = 'left'
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
      // Reference layout: the polar scope on the left, Width /
      // Correlation / Peak as a right-hand value column. Narrow cards
      // keep the old single-line readout above the scope.
      const twoCol = w >= 340
      const cx = twoCol ? Math.min(w * 0.3, 130) : w / 2
      const cy = (h - 30) / 2 + 10
      const radius = (twoCol ? Math.min(w * 0.55, h - 30) : Math.min(w, h - 30)) / 2 - 10
      drawPolarGrid(g, cx, cy, radius)
      drawCentreHalo(g, cx, cy, radius * 0.45)
      // Mid vertical, side horizontal: mono = vertical line, out of
      // phase = horizontal line. Dots, not a polyline: the field is a
      // cloud, and connecting samples in time order would draw chords
      // the field does not contain. No shadowBlur here — hundreds of
      // glowing dots would cost frames; the halo above carries the
      // glow for this meter.
      g.fillStyle = AURA.accentSoft
      const n = Math.min(left.length, right.length)
      for (let i = 0; i < n; i++) {
        const l = left[i]!
        const r = right[i]!
        const x = cx + ((l - r) / 2) * radius * 1.414
        const y = cy - ((l + r) / 2) * radius * 1.414
        g.fillRect(x, y, 1.5, 1.5)
      }
      const peakDb = Math.max(levels.leftPeakDb, levels.rightPeakDb)
      g.fillStyle = AURA.muted
      if (twoCol) {
        const colX = w * 0.58
        const fmtDb = (db: number) => (db <= DB_FLOOR ? '-∞' : db.toFixed(1))
        g.font = '11px sans-serif'
        g.fillText('Width', colX, 52)
        g.fillStyle = AURA.text
        g.font = '700 22px sans-serif'
        g.fillText(`${(levels.width * 100).toFixed(0)}%`, colX, 78)
        g.fillStyle = AURA.muted
        g.font = '11px sans-serif'
        g.fillText('Correlation', colX, 104)
        g.fillStyle = AURA.text
        g.font = '700 22px sans-serif'
        g.fillText(levels.correlation.toFixed(2), colX, 130)
        g.fillStyle = AURA.muted
        g.font = '11px sans-serif'
        g.fillText('Peak', colX, 156)
        g.fillStyle = AURA.text
        g.font = '700 22px sans-serif'
        g.fillText(`${fmtDb(peakDb)} dB`, colX, 182)
        g.fillStyle = AURA.muted
        g.font = '11px sans-serif'
        g.fillText('L', cx - radius, h - 4)
        g.fillText('R', cx + radius - 8, h - 4)
        g.textAlign = 'center'
        g.fillText('mid ↑  side →', cx, h - 18)
        g.textAlign = 'left'
      } else {
        g.font = '11px sans-serif'
        g.fillText(
          `width ${(levels.width * 100).toFixed(0)}%  corr ${levels.correlation.toFixed(2)}  peak ${peakDb <= DB_FLOOR ? '-∞' : peakDb.toFixed(1)} dB`,
          4,
          14,
        )
        g.fillText('L', 4, h - 4)
        g.fillText('R', w - 12, h - 4)
        g.fillText('mid ↑  side →', w / 2 - 30, h - 4)
      }
    },
    [],
  )
  return <MeterShell canvasRef={ref} />
}

/* ── 11. Phase Correlation — correlation history (stereo only) ────────── */

/**
 * Correlation over time, drawn the way the reference figure does: a
 * horizontal scrolling trace, newest at the right, correlation on the
 * vertical (−1 bottom, +1 top, 0 on the midline). The reference's own
 * labelling puts −1 / 0 / +1 along the bottom with a vertical line at
 * the 0 position, which does not cohere as a time-series axis — the
 * figure is decorative there — so this reproduces the figure's visual
 * arrangement (horizontal trace, −1/0/+1 at the bottom, vertical
 * centre line) while the trace itself stays a true correlation
 * history: its height is the value, the midline is 0, and the warm
 * tint below the midline is the negative region. Values come from the
 * same `computeStereoLevels` the XY scope and stereo field use — one
 * definition, three views.
 */
const PHASE_HISTORY_MAX = 160

function PhaseCorrelation({ source }: MeterProps): ReactElement {
  const historyRef = useRef<number[]>([])
  const ref = useMeterCanvas(
    source,
    (g, w, h, frame) => {
      if (!frame || frame.channels !== 2 || !frame.left || !frame.right) {
        drawPlaceholder(g, w, h, STEREO_PLACEHOLDER)
        return
      }
      const left = samplesFromBytes(frame.left.timeDomainData)
      const right = samplesFromBytes(frame.right.timeDomainData)
      const { correlation } = computeStereoLevels(left, right)
      const history = historyRef.current
      history.push(correlation)
      while (history.length > PHASE_HISTORY_MAX) history.shift()

      const top = 24
      const bottom = h - 16
      const corrY = (corr: number) => top + (1 - (corr + 1) / 2) * (bottom - top)
      // Negative half: warm warning tint below the 0 midline.
      g.fillStyle = 'rgba(255, 154, 92, 0.07)'
      g.fillRect(0, corrY(0), w, bottom - corrY(0))
      // Grid: ±0.5 faint, 0 strong (horizontal midline); vertical
      // centre line at the 0 position, as in the reference.
      g.strokeStyle = AURA.grid
      g.lineWidth = 1
      g.beginPath()
      for (const c of [-0.5, 0.5]) {
        g.moveTo(0, corrY(c))
        g.lineTo(w, corrY(c))
      }
      g.stroke()
      g.strokeStyle = AURA.gridStrong
      g.beginPath()
      g.moveTo(0, corrY(0))
      g.lineTo(w, corrY(0))
      g.stroke()
      g.strokeStyle = AURA.accentSoft
      g.beginPath()
      g.moveTo(w / 2, top)
      g.lineTo(w / 2, bottom)
      g.stroke()
      // History trace, oldest at the left, newest at the right.
      const n = history.length
      withGlow(g, 'rgba(127, 231, 196, 0.55)', 6, () => {
        g.strokeStyle = AURA.accent
        g.lineWidth = 1.5
        g.beginPath()
        for (let i = 0; i < n; i++) {
          const x = n <= 1 ? w : (i / (n - 1)) * w
          const y = corrY(history[i]!)
          if (i === 0) g.moveTo(x, y)
          else g.lineTo(x, y)
        }
        g.stroke()
      })
      // Newest point: bright dot with a halo, at the right edge.
      if (n > 0) {
        const y = corrY(history[n - 1]!)
        drawCentreHalo(g, w - 4, y, 10)
        g.fillStyle = AURA.accent
        g.beginPath()
        g.arc(w - 4, y, 3, 0, Math.PI * 2)
        g.fill()
      }
      g.fillStyle = AURA.text
      g.font = '700 16px sans-serif'
      g.textAlign = 'right'
      g.fillText(correlation.toFixed(2), w - 4, 18)
      g.textAlign = 'left'
      if (correlation < 0) {
        g.fillStyle = AURA.peak
        g.font = '11px sans-serif'
        g.fillText('负相关警告', 4, top + 14)
      }
      g.fillStyle = AURA.muted
      g.font = '10px sans-serif'
      g.fillText('-1', 2, h - 4)
      g.fillText('0', w / 2 - 3, h - 4)
      g.fillText('+1', w - 16, h - 4)
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
    case 'phase-correlation':
      return <PhaseCorrelation source={source} palette={palette} zoom={zoom} />
  }
}
