/**
 * bbebee-plugin-visualizer-meters — desktop UI half.
 *
 * One view, three meters, all fed by the `visualizer` service that the
 * first-party `@BBeBee/plugin-visualizer` plugin provides:
 *
 * - **Spectrum** — frequency bars over logarithmically spaced bands.
 * - **Spectrogram** — scrolling waterfall of past spectrum frames.
 * - **VU** — RMS level bar + peak marker on a dB scale, with classic
 *   attack/release/peak-hold ballistics.
 *
 * How the pieces follow the host's conventions:
 * - The def is a plain structural object (`{ name, inject, apply }`), no
 *   Cordis runtime import — same shape as first-party UI packages.
 * - The view is registered with `ctx.ui.registerView` and contributed into
 *   the `now-playing.visualizer` slot — the same slot the built-in
 *   visualizer canvas uses — via `ctx.ui.contribute({ kind: 'slot', … })`.
 * - Components receive the plugin `ctx` through a bound closure and read
 *   services with a local `serviceOf` that mirrors `@BBeBee/toolkit/hooks`
 *   (`ctx.reflect.get(key, false)`), so a missing service is a value to
 *   handle, not an exception: with no visualizer (or no audio) the meters
 *   draw a quiet baseline instead of failing.
 * - React comes from the host. This bundle never contains a React copy —
 *   `build.mjs` keeps the host-shared specifiers external (single source of
 *   truth: `apps/desktop/renderer/host-modules.manifest.ts`) and fails the
 *   build if a React implementation sneaks in.
 * - Styling uses host CSS variables only (with fallbacks); no ui-kit
 *   import — a third-party bundle stays self-contained apart from the
 *   host-shared modules.
 */

import {
  createElement as h,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react'
import type { ReactElement } from 'react'
import {
  METERS_MODES,
  METERS_PALETTES,
  DEFAULT_METERS_CONFIG,
  type MetersConfig,
  type MetersMode,
  type MetersPaletteName,
} from './config.js'
import {
  DB_FLOOR,
  PALETTE_STOPS,
  WaterfallBuffer,
  aggregateBands,
  buildPaletteLut,
  computePeak,
  computeRms,
  createVuState,
  dbToFraction,
  levelToDb,
  logBandEdges,
  lutColor,
  stepVu,
  type VuState,
} from './meters-math.js'

/* ── Minimal host context surface (structural, no runtime imports) ────── */

interface LoggerLike {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
}

/**
 * The protocol `VisualizerService` surface this view consumes:
 * `getFrequencyData` fills a byte array of `fftSize / 2` entries (0-filled
 * by the service itself when no analyser is attached), and
 * `getTimeDomainData` fills a byte array of `fftSize` entries (128-filled
 * = silence). `settings.fftSize` is the sizing source for both buffers.
 */
interface VisualizerServiceLike {
  readonly settings: { fftSize?: number }
  getFrequencyData(array: Uint8Array): void
  getTimeDomainData(array: Uint8Array): void
}

interface UiServiceLike {
  registerView(id: string, component: unknown): unknown
  contribute(contribution: unknown): unknown
}

interface PluginContextLike {
  logger: LoggerLike
  ui: UiServiceLike
  effect(fn: unknown, name?: string): unknown
  reflect?: { get(key: string, strict?: boolean): unknown }
  [key: string]: unknown
}

/** Local mirror of `@BBeBee/toolkit/hooks`' `serviceOf(ctx, key)`. */
function serviceOf<T>(ctx: PluginContextLike, key: string): T | undefined {
  try {
    const fromReflect = ctx.reflect?.get(key, false)
    if (fromReflect !== undefined && fromReflect !== null) return fromReflect as T
  } catch {
    // fall through to the property access below
  }
  const value = ctx[key]
  return value === undefined || value === null ? undefined : (value as T)
}

/* ── Shared view state (this bundle only) ───────────────────────────────── */

/**
 * Mode + palette live in a tiny module-level store so the meters view and
 * the settings card — both registered by this def, both in this bundle —
 * stay in sync. Seeded from the same defaults the headless half resolves;
 * session-local by design (see `src/config.ts` for why).
 */
type MetersUiState = MetersConfig

let uiSnapshot: MetersUiState = { ...DEFAULT_METERS_CONFIG }
const uiListeners = new Set<() => void>()

function setUiState(patch: Partial<MetersUiState>): void {
  uiSnapshot = { ...uiSnapshot, ...patch }
  for (const listener of uiListeners) listener()
}

function subscribeUi(listener: () => void): () => void {
  uiListeners.add(listener)
  return () => {
    uiListeners.delete(listener)
  }
}

function useMetersUiState(): MetersUiState {
  return useSyncExternalStore(subscribeUi, () => uiSnapshot, () => uiSnapshot)
}

/* ── Small controls ─────────────────────────────────────────────────────── */

const MODE_LABELS: Record<MetersMode, string> = {
  spectrum: 'Spectrum',
  spectrogram: 'Spectrogram',
  vu: 'VU',
}

function ModeSwitch({ value, onChange }: { value: MetersMode; onChange: (m: MetersMode) => void }) {
  return (
    <div
      role="tablist"
      aria-label="Meter mode"
      style={{ display: 'inline-flex', gap: 2, padding: 2, borderRadius: 6, border: '1px solid var(--border-subtle, rgba(127, 127, 127, 0.35))' }}
    >
      {METERS_MODES.map((mode) => (
        <button
          key={mode}
          role="tab"
          aria-selected={mode === value}
          onClick={() => onChange(mode)}
          style={{
            border: 'none',
            borderRadius: 4,
            padding: '2px 8px',
            fontSize: 12,
            cursor: 'pointer',
            color: 'var(--color-text-primary, inherit)',
            background:
              mode === value ? 'var(--color-primary, #5f87ff)' : 'transparent',
          }}
        >
          {MODE_LABELS[mode]}
        </button>
      ))}
    </div>
  )
}

function PaletteSwitch({
  value,
  onChange,
}: {
  value: MetersPaletteName
  onChange: (p: MetersPaletteName) => void
}) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
      Palette
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as MetersPaletteName)}
        style={{
          fontSize: 12,
          color: 'var(--color-text-primary, inherit)',
          background: 'transparent',
          border: '1px solid var(--border-subtle, rgba(127, 127, 127, 0.35))',
          borderRadius: 4,
          padding: '2px 4px',
        }}
      >
        {METERS_PALETTES.map((palette) => (
          <option key={palette} value={palette}>
            {palette}
          </option>
        ))}
      </select>
    </label>
  )
}

/* ── The meters view ────────────────────────────────────────────────────── */

const SPECTRUM_BANDS = 48
const WATERFALL_COLUMNS = 240
const DB_TICKS = [-40, -30, -20, -12, -9, -6, -3, 0] as const

export interface MetersViewProps {
  ctx: PluginContextLike
  height?: number
}

export function MetersView({ ctx, height = 132 }: MetersViewProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const uiState = useMetersUiState()
  // The draw loop reads the freshest UI state through a ref so it never
  // has to be torn down and rebuilt when the user flips a control.
  const uiStateRef = useRef(uiState)
  uiStateRef.current = uiState

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const g = canvas.getContext('2d')
    if (!g) return

    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    let cssWidth = 320
    let cssHeight = height

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      cssWidth = rect.width || 320
      cssHeight = rect.height || height
      canvas.width = Math.max(1, Math.floor(cssWidth * dpr))
      canvas.height = Math.max(1, Math.floor(cssHeight * dpr))
    }
    resize()
    const observer =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null
    observer?.observe(canvas)

    // Frame state, all local to this mount.
    let fftSize = 0
    let freq = new Uint8Array(0)
    let time = new Uint8Array(0)
    let waterfall: WaterfallBuffer | null = null
    let waterfallBins = 0
    let vu: VuState = createVuState()
    const lutCache = new Map<MetersPaletteName, Uint8Array>()
    const lutFor = (palette: MetersPaletteName): Uint8Array => {
      let lut = lutCache.get(palette)
      if (!lut) {
        lut = buildPaletteLut(PALETTE_STOPS[palette] ?? PALETTE_STOPS.ember!)
        lutCache.set(palette, lut)
      }
      return lut
    }
    // Offscreen strip for the spectrogram: one pixel per (column, bin).
    const strip = document.createElement('canvas')
    const stripCtx = strip.getContext('2d')

    const drawBaseline = (w: number, hgt: number) => {
      g.strokeStyle = 'rgba(127, 127, 127, 0.45)'
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(0, hgt - 0.5)
      g.lineTo(w, hgt - 0.5)
      g.stroke()
    }

    const drawSpectrum = (w: number, hgt: number, lut: Uint8Array) => {
      const edges = logBandEdges(freq.length, SPECTRUM_BANDS)
      const bands = aggregateBands(freq, edges)
      const gap = 2
      const barWidth = Math.max(1, (w - (bands.length - 1) * gap) / bands.length)
      for (let i = 0; i < bands.length; i++) {
        const value = bands[i]!
        const barHeight = Math.max(value > 0 ? 2 : 0, value * (hgt - 4))
        if (barHeight <= 0) continue
        const [r, gg, b] = lutColor(lut, value * 255)
        g.fillStyle = `rgb(${r}, ${gg}, ${b})`
        g.fillRect(i * (barWidth + gap), hgt - barHeight, barWidth, barHeight)
      }
      drawBaseline(w, hgt)
    }

    const drawSpectrogram = (w: number, hgt: number, lut: Uint8Array) => {
      if (!waterfall || !stripCtx) {
        drawBaseline(w, hgt)
        return
      }
      const bins = waterfallBins
      if (strip.width !== WATERFALL_COLUMNS || strip.height !== bins) {
        strip.width = WATERFALL_COLUMNS
        strip.height = Math.max(1, bins)
      }
      const image = stripCtx.createImageData(strip.width, strip.height)
      for (let x = 0; x < strip.width; x++) {
        // Left edge = oldest stored frame, right edge = newest.
        const column = waterfall.columnAtAge(strip.width - 1 - x)
        for (let bin = 0; bin < bins; bin++) {
          // Bin 0 (lowest frequency) belongs at the bottom: ImageData row 0
          // is the top, so rows are written flipped.
          const row = bins - 1 - bin
          const offset = (row * strip.width + x) * 4
          const value = column ? (column[bin] ?? 0) : 0
          const [r, gg, b] = lutColor(lut, value)
          image.data[offset] = r
          image.data[offset + 1] = gg
          image.data[offset + 2] = b
          image.data[offset + 3] = 255
        }
      }
      stripCtx.putImageData(image, 0, 0)
      g.imageSmoothingEnabled = true
      g.clearRect(0, 0, w, hgt)
      g.drawImage(strip, 0, 0, w, hgt)
    }

    const drawVu = (w: number, hgt: number, lut: Uint8Array) => {
      const midY = Math.floor(hgt / 2)
      const trackY = midY - 7
      const trackHeight = 14
      // Track + dB ticks.
      g.fillStyle = 'rgba(127, 127, 127, 0.25)'
      g.fillRect(0, trackY, w, trackHeight)
      g.fillStyle = 'rgba(127, 127, 127, 0.8)'
      g.font = '10px sans-serif'
      for (const db of DB_TICKS) {
        const x = dbToFraction(db) * w
        g.fillRect(x, trackY + trackHeight + 2, 1, 4)
        g.fillText(`${db}`, x + 2, trackY + trackHeight + 14)
      }
      // Level bar, coloured by level through the active palette.
      const levelFraction = dbToFraction(vu.levelDb)
      if (levelFraction > 0) {
        const [r, gg, b] = lutColor(lut, levelFraction * 255)
        g.fillStyle = `rgb(${r}, ${gg}, ${b})`
        g.fillRect(0, trackY, levelFraction * w, trackHeight)
      }
      // Peak marker.
      const peakX = dbToFraction(vu.peakDb) * w
      g.fillStyle = 'rgba(255, 80, 80, 0.95)'
      g.fillRect(Math.max(0, peakX - 1), trackY - 3, 2, trackHeight + 6)
      // Readout.
      g.fillStyle = 'rgba(127, 127, 127, 0.9)'
      const label = (db: number) => (db <= DB_FLOOR ? '-∞ dB' : `${db.toFixed(1)} dB`)
      g.fillText(`RMS ${label(vu.levelDb)}   peak ${label(vu.peakDb)}`, 0, 12)
      if (vu.levelDb <= DB_FLOOR && vu.peakDb <= DB_FLOOR) drawBaseline(w, hgt)
    }

    let animId = 0
    const render = () => {
      animId = requestAnimationFrame(render)
      const { mode, palette } = uiStateRef.current
      const lut = lutFor(palette)

      // Pull one frame from the visualizer service, if it is there. The
      // buffers follow the service's fftSize; without a service the
      // buffers stay zeroed (128-centred for time domain) and every mode
      // draws its quiet baseline.
      const visualizer = serviceOf<VisualizerServiceLike>(ctx, 'visualizer')
      const targetFft = clampFftSize(visualizer?.settings?.fftSize ?? 128)
      if (targetFft !== fftSize) {
        fftSize = targetFft
        freq = new Uint8Array(fftSize / 2)
        time = new Uint8Array(fftSize)
        waterfall = null
        waterfallBins = 0
      }
      if (visualizer) {
        visualizer.getFrequencyData(freq)
        visualizer.getTimeDomainData(time)
      } else {
        freq.fill(0)
        time.fill(128)
      }

      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, cssWidth, cssHeight)

      if (mode === 'spectrum') {
        drawSpectrum(cssWidth, cssHeight, lut)
      } else if (mode === 'spectrogram') {
        if (!waterfall || waterfallBins !== freq.length) {
          waterfall = new WaterfallBuffer(WATERFALL_COLUMNS, freq.length)
          waterfallBins = freq.length
        }
        waterfall.push(freq)
        drawSpectrogram(cssWidth, cssHeight, lut)
      } else {
        vu = stepVu(vu, levelToDb(computeRms(time)), levelToDb(computePeak(time)))
        drawVu(cssWidth, cssHeight, lut)
      }
    }
    animId = requestAnimationFrame(render)

    return () => {
      if (animId) cancelAnimationFrame(animId)
      observer?.disconnect()
    }
  }, [ctx, height])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        width: '100%',
        maxWidth: 560,
        color: 'var(--color-text-primary, inherit)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <ModeSwitch value={uiState.mode} onChange={(mode) => setUiState({ mode })} />
        <PaletteSwitch value={uiState.palette} onChange={(palette) => setUiState({ palette })} />
      </div>
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height,
          display: 'block',
          borderRadius: 6,
          border: '1px solid var(--border-subtle, rgba(127, 127, 127, 0.35))',
          background: 'var(--color-bg-app, transparent)',
        }}
      />
    </div>
  )
}

function clampFftSize(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 128
  const power = Math.round(Math.log2(value))
  return Math.min(2048, Math.max(32, 2 ** power))
}

/* ── The settings card view ─────────────────────────────────────────────── */

export function MetersSettingsCard({ ctx }: { ctx: PluginContextLike }): ReactElement {
  const uiState = useMetersUiState()
  const visualizer = serviceOf<VisualizerServiceLike>(ctx, 'visualizer')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 560 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <ModeSwitch value={uiState.mode} onChange={(mode) => setUiState({ mode })} />
        <PaletteSwitch value={uiState.palette} onChange={(palette) => setUiState({ palette })} />
      </div>
      <p style={{ margin: 0, fontSize: 12, opacity: 0.75 }}>
        These defaults seed the Visualizer Meters view in the now-playing screen. The{' '}
        <code>visualizer</code> service is{' '}
        {visualizer ? 'available' : 'not available — the meters will show a quiet baseline'}.
        Changes are session-local in this example (see the package README).
      </p>
    </div>
  )
}

/* ── Plugin def ─────────────────────────────────────────────────────────── */

export const name = 'bbebee-plugin-visualizer-meters-ui'

/**
 * Only `ui` is hard-injected: without it there is nowhere to register the
 * views. The `visualizer` service is read opportunistically per frame via
 * `serviceOf`, so the view still mounts (and draws its baseline) when the
 * visualizer plugin is disabled or absent.
 */
export const inject: readonly string[] = ['ui']

function bound<P extends { ctx: PluginContextLike }>(
  ctx: PluginContextLike,
  Screen: (props: P) => ReactElement | null,
): (props: Omit<P, 'ctx'>) => ReactElement | null {
  return function Bound(props) {
    return h(Screen, { ...props, ctx } as P)
  }
}

export async function apply(ctx: PluginContextLike) {
  ctx.logger.info('visualizer-meters ui: loaded')

  return ctx.effect(function* () {
    yield ctx.ui.registerView('visualizer-meters.canvas', bound(ctx, MetersView))
    yield ctx.ui.registerView('visualizer-meters.settings', bound(ctx, MetersSettingsCard))
    yield ctx.ui.contribute({
      kind: 'slot',
      id: 'visualizer-meters.canvas',
      slot: 'now-playing.visualizer',
      order: 20,
    })
  }, 'visualizer-meters-ui')
}

export default { name, inject, apply }
