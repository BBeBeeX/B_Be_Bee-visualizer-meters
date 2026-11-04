/**
 * workspace.ts — the meters workspace: layout model, presets, persistence.
 *
 * Pure layout math first, DOM nowhere: every function here takes and
 * returns plain data, so the model is unit-tested without a browser
 * (`test/workspace.test.ts`) and the React page in `./ui.tsx` is only a
 * thin pointer-event skin over it.
 *
 * ## Model
 *
 * A workspace is a named set of panels on a free canvas. Panels are
 * positioned in CSS pixels, snapped to a 20 px grid when snapping is on
 * (the grid is a *placement* aid, not a tiling constraint — panels may
 * overlap, and array order is z-order, last = front). "Window
 * composition" is exactly this: pick any meters, put them anywhere, save
 * the arrangement, restore it later.
 *
 * ## The ten meters
 *
 * The two reference UIs collapse to ten distinct components (the
 * spectrogram appears in both figures, counted once):
 *
 * - SignalScope XM (figure 2): FFT Analyzer, Oscilloscope, Octave
 *   Analyzer, Spectrogram, XY Scope.
 * - AURA (figure 1): Spectrum Analyzer, Waveform, Stereo Level Meter,
 *   Loudness Meter, Stereo Field, Spectrogram (again).
 *
 * "FFT Analyzer" and "Spectrum Analyzer" are deliberately separate
 * components sharing one frame source: the FFT analyzer draws the
 * per-bin line on a dB scale (analysis detail), the spectrum analyzer
 * draws log-spaced bars (at-a-glance levels). Merging them would lose
 * one of the two reference behaviours.
 *
 * ## Persistence — no new capability
 *
 * A workspace JSON is a few kilobytes of panel rectangles, so it fits
 * the host's namespaced key/value store (`ctx.store`: "small,
 * frequently read settings"), which first-party plugins already use
 * for exactly this kind of state without any manifest capability.
 * The README's earlier claim that persistence "would need `db:own`"
 * was overstated for this size: `db:own` is for plugin-owned SQL
 * tables, not for a settings blob. The storage resolution below is
 * therefore: host store when the view can reach one, `localStorage`
 * as a desktop-webview fallback, in-memory session state otherwise —
 * and the page always shows which one is in effect, plus JSON
 * export/import, so a workspace is never trapped in one backend.
 * Adding `db:own` to the manifest would change the install grant and
 * is not done in this change.
 */

export type MeterKind =
  | 'fft-analyzer'
  | 'oscilloscope'
  | 'octave-analyzer'
  | 'spectrogram'
  | 'xy-scope'
  | 'spectrum-analyzer'
  | 'waveform'
  | 'stereo-level'
  | 'loudness'
  | 'stereo-field'

export const METER_KINDS: readonly MeterKind[] = [
  'fft-analyzer',
  'oscilloscope',
  'octave-analyzer',
  'spectrogram',
  'xy-scope',
  'spectrum-analyzer',
  'waveform',
  'stereo-level',
  'loudness',
  'stereo-field',
]

export interface MeterMeta {
  title: string
  titleZh: string
  /** True when the meter is meaningless without per-channel data. */
  needsStereo: boolean
  /** True when the panel's zoom control changes the meter's axis. */
  hasZoom: boolean
  description: string
}

export const METER_META: Record<MeterKind, MeterMeta> = {
  'fft-analyzer': {
    title: 'FFT Analyzer', titleZh: 'FFT 频谱分析', needsStereo: false, hasZoom: true,
    description: 'Per-bin magnitude line on a dB scale, log frequency axis.',
  },
  oscilloscope: {
    title: 'Oscilloscope', titleZh: '示波器', needsStereo: false, hasZoom: true,
    description: 'Latest time-domain frame, channels overlaid, ms time axis.',
  },
  'octave-analyzer': {
    title: 'Octave Analyzer', titleZh: '倍频程分析', needsStereo: false, hasZoom: true,
    description: '1/1- or 1/3-octave bands with centre-frequency labels.',
  },
  spectrogram: {
    title: 'Spectrogram', titleZh: '频谱瀑布', needsStereo: false, hasZoom: true,
    description: 'Scrolling time × log-frequency waterfall through a colour LUT.',
  },
  'xy-scope': {
    title: 'XY Scope', titleZh: 'XY 示波', needsStereo: true, hasZoom: false,
    description: 'Lissajous plot: left channel against right channel.',
  },
  'spectrum-analyzer': {
    title: 'Spectrum Analyzer', titleZh: '频谱', needsStereo: false, hasZoom: true,
    description: 'Log-spaced frequency bars, at-a-glance levels.',
  },
  waveform: {
    title: 'Waveform', titleZh: '波形', needsStereo: false, hasZoom: true,
    description: 'Scrolling frame-stitched waveform history, channels stacked.',
  },
  'stereo-level': {
    title: 'Stereo Level Meter', titleZh: '立体声电平', needsStereo: true, hasZoom: false,
    description: 'Per-channel RMS + peak bars on a dB scale with peak hold.',
  },
  loudness: {
    title: 'Loudness Meter', titleZh: '响度', needsStereo: false, hasZoom: false,
    description: 'Momentary / short-term / integrated loudness (approximate, see meters-math).',
  },
  'stereo-field': {
    title: 'Stereo Field', titleZh: '声场', needsStereo: true, hasZoom: false,
    description: 'Goniometer: mid vertical, side horizontal, plus width and correlation.',
  },
}

export const WORKSPACE_VERSION = 1
export const WORKSPACE_GRID_PX = 20
export const PANEL_MIN_W = 220
export const PANEL_MIN_H = 150
export const WORKSPACE_STORE_KEY = 'visualizer-meters.workspace.v1'

export interface Panel {
  id: string
  kind: MeterKind
  x: number
  y: number
  w: number
  h: number
  /** Axis zoom factor (1 = full range); only kinds with hasZoom use it. */
  zoom?: number
}

export interface Workspace {
  version: 1
  name: string
  palette: 'ember' | 'ice' | 'mono'
  snap: boolean
  panels: Panel[]
}

export function snapToGrid(value: number, gridPx: number = WORKSPACE_GRID_PX): number {
  // The `+ 0` normalises −0 (from rounding a small negative) to 0.
  return Math.round(value / gridPx) * gridPx + 0
}

function clampNumber(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo
  return Math.min(hi, Math.max(lo, value))
}

export function clampPanel(panel: Panel, bounds?: { width: number; height: number }): Panel {
  const w = clampNumber(panel.w, PANEL_MIN_W, 1200)
  const h = clampNumber(panel.h, PANEL_MIN_H, 900)
  const x = bounds ? clampNumber(panel.x, 0, Math.max(0, bounds.width - PANEL_MIN_W)) : Math.max(0, panel.x)
  const y = bounds ? clampNumber(panel.y, 0, Math.max(0, bounds.height - PANEL_MIN_H)) : Math.max(0, panel.y)
  return { ...panel, x, y, w, h }
}

function isKind(value: unknown): value is MeterKind {
  return typeof value === 'string' && (METER_KINDS as readonly string[]).includes(value)
}

function isPalette(value: unknown): value is Workspace['palette'] {
  return value === 'ember' || value === 'ice' || value === 'mono'
}

let panelCounter = 0
export function nextPanelId(): string {
  panelCounter += 1
  return `panel-${Date.now().toString(36)}-${panelCounter}`
}

/** Places a new panel at a cascade offset so it never hides exactly behind another. */
export function addPanel(workspace: Workspace, kind: MeterKind): Workspace {
  const offset = (workspace.panels.length % 6) * WORKSPACE_GRID_PX
  const panel: Panel = {
    id: nextPanelId(),
    kind,
    x: 20 + offset,
    y: 20 + offset,
    w: 380,
    h: 260,
  }
  return { ...workspace, panels: [...workspace.panels, panel] }
}

export function removePanel(workspace: Workspace, id: string): Workspace {
  return { ...workspace, panels: workspace.panels.filter((p) => p.id !== id) }
}

/** Moves a panel (snapping when the workspace has snap on) and brings it to front. */
export function movePanel(workspace: Workspace, id: string, x: number, y: number): Workspace {
  const target = workspace.panels.find((p) => p.id === id)
  if (!target) return workspace
  const nx = workspace.snap ? snapToGrid(x) : Math.round(x)
  const ny = workspace.snap ? snapToGrid(y) : Math.round(y)
  const moved = clampPanel({ ...target, x: Math.max(0, nx), y: Math.max(0, ny) })
  const rest = workspace.panels.filter((p) => p.id !== id)
  return { ...workspace, panels: [...rest, moved] }
}

/** Resizes a panel (snapping when on, clamped to the panel minimums). */
export function resizePanel(workspace: Workspace, id: string, w: number, h: number): Workspace {
  const target = workspace.panels.find((p) => p.id === id)
  if (!target) return workspace
  const nw = workspace.snap ? snapToGrid(w) : Math.round(w)
  const nh = workspace.snap ? snapToGrid(h) : Math.round(h)
  const resized = clampPanel({ ...target, w: nw, h: nh })
  return { ...workspace, panels: workspace.panels.map((p) => (p.id === id ? resized : p)) }
}

/** Brings a panel to front (array order is z-order). */
export function bringToFront(workspace: Workspace, id: string): Workspace {
  const target = workspace.panels.find((p) => p.id === id)
  if (!target) return workspace
  return { ...workspace, panels: [...workspace.panels.filter((p) => p.id !== id), target] }
}

export function setPanelZoom(workspace: Workspace, id: string, zoom: number): Workspace {
  const value = clampNumber(zoom, 0.5, 4)
  return {
    ...workspace,
    panels: workspace.panels.map((p) => (p.id === id ? { ...p, zoom: value } : p)),
  }
}

/**
 * Validates untrusted workspace JSON (imported file, host store, …):
 * unknown fields are dropped, unknown meter kinds are dropped, bad
 * numbers fall back to safe defaults, duplicate ids are de-duplicated.
 * Returns null only when the input is not an object at all.
 */
export function validateWorkspace(input: unknown): Workspace | null {
  if (input === null || typeof input !== 'object') return null
  const raw = input as Record<string, unknown>
  const panelsRaw = Array.isArray(raw.panels) ? raw.panels : []
  const seen = new Set<string>()
  const panels: Panel[] = []
  for (const entry of panelsRaw) {
    if (entry === null || typeof entry !== 'object') continue
    const p = entry as Record<string, unknown>
    if (!isKind(p.kind)) continue
    const id = typeof p.id === 'string' && p.id.length > 0 ? p.id : nextPanelId()
    if (seen.has(id)) continue
    seen.add(id)
    const zoom =
      typeof p.zoom === 'number' && Number.isFinite(p.zoom)
        ? clampNumber(p.zoom, 0.5, 4)
        : undefined
    panels.push(
      clampPanel({
        id,
        kind: p.kind,
        x: typeof p.x === 'number' ? p.x : 20,
        y: typeof p.y === 'number' ? p.y : 20,
        w: typeof p.w === 'number' ? p.w : 380,
        h: typeof p.h === 'number' ? p.h : 260,
        ...(zoom !== undefined ? { zoom } : {}),
      }),
    )
  }
  return {
    version: 1,
    name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : 'Meters',
    palette: isPalette(raw.palette) ? raw.palette : 'ember',
    snap: raw.snap !== false,
    panels,
  }
}

export function serializeWorkspace(workspace: Workspace): string {
  return JSON.stringify(workspace, null, 2)
}

export function parseWorkspace(text: string): Workspace | null {
  try {
    return validateWorkspace(JSON.parse(text) as unknown)
  } catch {
    return null
  }
}

/* ── Presets: the two reference figures, plus everything at once ──────── */

function panelAt(kind: MeterKind, x: number, y: number, w = 380, h = 260): Panel {
  return { id: nextPanelId(), kind, x, y, w, h }
}

export type WorkspacePresetId = 'signal-scope' | 'aura' | 'studio'

export const WORKSPACE_PRESETS: Record<
  WorkspacePresetId,
  { name: string; build: (palette: Workspace['palette']) => Workspace }
> = {
  'signal-scope': {
    name: 'SignalScope',
    build: (palette) => ({
      version: 1,
      name: 'SignalScope',
      palette,
      snap: true,
      panels: [
        panelAt('fft-analyzer', 20, 20, 580, 300),
        panelAt('oscilloscope', 620, 20, 580, 300),
        panelAt('octave-analyzer', 20, 340, 580, 300),
        panelAt('spectrogram', 620, 340, 580, 300),
        panelAt('xy-scope', 20, 660, 580, 300),
      ],
    }),
  },
  aura: {
    name: 'AURA',
    build: (palette) => ({
      version: 1,
      name: 'AURA',
      palette,
      snap: true,
      panels: [
        panelAt('spectrum-analyzer', 20, 20, 580, 300),
        panelAt('waveform', 620, 20, 580, 300),
        panelAt('stereo-level', 20, 340, 380, 300),
        panelAt('loudness', 420, 340, 380, 300),
        panelAt('stereo-field', 820, 340, 380, 300),
        panelAt('spectrogram', 20, 660, 1180, 300),
      ],
    }),
  },
  studio: {
    name: 'Studio (all meters)',
    build: (palette) => ({
      version: 1,
      name: 'Studio',
      palette,
      snap: true,
      panels: [
        panelAt('fft-analyzer', 20, 20, 380, 260),
        panelAt('oscilloscope', 420, 20, 380, 260),
        panelAt('octave-analyzer', 820, 20, 380, 260),
        panelAt('spectrogram', 20, 300, 380, 260),
        panelAt('xy-scope', 420, 300, 380, 260),
        panelAt('spectrum-analyzer', 820, 300, 380, 260),
        panelAt('waveform', 20, 580, 380, 260),
        panelAt('stereo-level', 420, 580, 380, 260),
        panelAt('loudness', 820, 580, 380, 260),
        panelAt('stereo-field', 20, 860, 380, 260),
      ],
    }),
  },
}

export function defaultWorkspace(): Workspace {
  return WORKSPACE_PRESETS.studio!.build('ember')
}

/* ── Storage: host store → localStorage → memory ──────────────────────── */

export interface StoreLike {
  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, value: T): Promise<void>
}

export interface WorkspaceStorage {
  readonly kind: 'store' | 'local' | 'memory'
  load(): Promise<Workspace | null>
  save(workspace: Workspace): Promise<void>
}

export function createMemoryWorkspaceStorage(): WorkspaceStorage {
  let held: Workspace | null = null
  return {
    kind: 'memory',
    load: async () => held,
    save: async (workspace) => {
      held = workspace
    },
  }
}

export function createStoreWorkspaceStorage(store: StoreLike): WorkspaceStorage {
  return {
    kind: 'store',
    load: async () => {
      try {
        const raw = await store.get<unknown>(WORKSPACE_STORE_KEY)
        return raw === undefined ? null : validateWorkspace(raw)
      } catch {
        return null
      }
    },
    save: async (workspace) => {
      await store.set(WORKSPACE_STORE_KEY, workspace)
    },
  }
}

export function createLocalWorkspaceStorage(): WorkspaceStorage | null {
  try {
    if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return null
    const storage = window.localStorage
    return {
      kind: 'local',
      load: async () => {
        const raw = storage.getItem(WORKSPACE_STORE_KEY)
        return raw === null ? null : parseWorkspace(raw)
      },
      save: async (workspace) => {
        storage.setItem(WORKSPACE_STORE_KEY, serializeWorkspace(workspace))
      },
    }
  } catch {
    return null
  }
}

/**
 * Note: this module intentionally imports nothing, so it stays runnable
 * under plain `node --test` (the repo's test setup strips types but
 * does not resolve `.js` → `.ts` specifiers). The context-aware
 * resolution — host store via `reflect`, then local, then memory —
 * lives in `./ui.tsx`, which already imports `serviceOf`.
 */
