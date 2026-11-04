/**
 * bbebee-plugin-visualizer-meters — desktop UI half.
 *
 * A meters *workspace* page, not a single meter: the ten independent
 * meter components in `./meters.tsx` (five from the SignalScope XM
 * figure, five more from the AURA figure, spectrogram shared) are
 * composed as draggable, resizable panels on a free canvas.
 *
 * - Drag: panel headers drag; resize: the bottom-right corner handle.
 * - Grid snap: 20 px, toggleable; when on, both drag and resize land
 *   on grid lines. Panels may overlap — array order is z-order, and
 *   clicking a panel brings it to front.
 * - Zoom: panels whose meter has an axis (FFT, spectrum, octave,
 *   spectrogram, oscilloscope, waveform) get − / + controls that scale
 *   that meter's axis; the factor is stored on the panel and saved
 *   with the workspace. Meters without an axis (levels, loudness,
 *   field, XY) have no zoom control, rather than a control that does
 *   nothing.
 * - Save: the workspace (layout, palette, snap, zoom) is written to
 *   the host store when the view can reach one, else to localStorage,
 *   else kept for the session — and the page says which. JSON
 *   export/import always works, so a workspace is never trapped in
 *   one backend. See `./workspace.ts` for why no `db:own` capability
 *   is needed for this.
 * - Live data: one `FrameSource` per page (see `./audio-frame.ts`),
 *   adapted from the `visualizer` service. Stereo meters render an
 *   explicit placeholder on today's mono source instead of fake data.
 *
 * The def shape follows the host's conventions (structural object, no
 * Cordis runtime import; React stays external via the import map —
 * see `build.mjs`).
 */

import {
  createElement as h,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactElement } from 'react'
import {
  DEFAULT_METERS_CONFIG,
  METERS_PALETTES,
  type MetersPaletteName,
} from './config.js'
import { createVisualizerFrameSource } from './audio-frame.js'
import type { FrameSource } from './audio-frame.js'
import { serviceOf } from './service-of.js'
import { MeterCanvas } from './meters.js'
import {
  addPanel,
  bringToFront,
  createLocalWorkspaceStorage,
  createMemoryWorkspaceStorage,
  createStoreWorkspaceStorage,
  defaultWorkspace,
  movePanel,
  METER_KINDS,
  METER_META,
  parseWorkspace,
  removePanel,
  resizePanel,
  serializeWorkspace,
  setPanelZoom,
  WORKSPACE_GRID_PX,
  WORKSPACE_PRESETS,
  type MeterKind,
  type Panel,
  type StoreLike,
  type Workspace,
  type WorkspacePresetId,
  type WorkspaceStorage,
} from './workspace.js'

/**
 * Resolves workspace storage for a view context, opportunistically:
 * the view's scoped context may expose `store` through `reflect`
 * (same mechanism the meters already use for `visualizer`); when it
 * does not, fall back without throwing. The page displays `kind` so
 * the user always knows where "saved" actually went.
 */
function resolveWorkspaceStorage(ctx: PluginContextLike): WorkspaceStorage {
  const store = serviceOf<StoreLike>(ctx, 'store')
  if (store && typeof store.get === 'function' && typeof store.set === 'function') {
    return createStoreWorkspaceStorage(store)
  }
  return createLocalWorkspaceStorage() ?? createMemoryWorkspaceStorage()
}

/* ── Minimal host context surface (structural, no runtime imports) ────── */

interface LoggerLike {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
}

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
  reflect?: { get(key: string, required: boolean): unknown }
  [key: string]: unknown
}

/* ── Legacy single-meter view (kept for bundle compatibility) ─────────── */

export interface MetersViewProps {
  ctx: PluginContextLike
  height?: number
}

/** A single spectrum meter, for embeds that predate the workspace page. */
export function MetersView({ ctx, height = 132 }: MetersViewProps): ReactElement {
  const visualizer = serviceOf<VisualizerServiceLike>(ctx, 'visualizer')
  const source = useMemo(() => createVisualizerFrameSource(visualizer), [visualizer])
  return (
    <div style={{ width: '100%', height }}>
      <MeterCanvas kind="spectrum-analyzer" source={source} palette="ember" />
    </div>
  )
}

/* ── One draggable, resizable panel ────────────────────────────────────── */

interface MeterPanelProps {
  panel: Panel
  zIndex: number
  snap: boolean
  palette: MetersPaletteName
  source: FrameSource
  onMove: (id: string, x: number, y: number) => void
  onResize: (id: string, w: number, h: number) => void
  onRemove: (id: string) => void
  onZoom: (id: string, zoom: number) => void
  onFocus: (id: string) => void
}

function MeterPanel({
  panel,
  zIndex,
  snap,
  palette,
  source,
  onMove,
  onResize,
  onRemove,
  onZoom,
  onFocus,
}: MeterPanelProps): ReactElement {
  const meta = METER_META[panel.kind]
  const dragRef = useRef<{
    type: 'move' | 'resize'
    startX: number
    startY: number
    origX: number
    origY: number
    origW: number
    origH: number
  } | null>(null)

  const startDrag = (type: 'move' | 'resize') => (event: React.PointerEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    onFocus(panel.id)
    dragRef.current = {
      type,
      startX: event.clientX,
      startY: event.clientY,
      origX: panel.x,
      origY: panel.y,
      origW: panel.w,
      origH: panel.h,
    }
    const onPointerMove = (move: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const dx = move.clientX - drag.startX
      const dy = move.clientY - drag.startY
      if (drag.type === 'move') {
        onMove(panel.id, drag.origX + dx, drag.origY + dy)
      } else {
        onResize(panel.id, drag.origW + dx, drag.origH + dy)
      }
    }
    const onPointerUp = () => {
      dragRef.current = null
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  }

  const zoom = panel.zoom ?? 1
  return (
    <div
      onPointerDown={() => onFocus(panel.id)}
      style={{
        position: 'absolute',
        left: panel.x,
        top: panel.y,
        width: panel.w,
        height: panel.h,
        zIndex,
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 8,
        border: '1px solid var(--border-subtle, rgba(127, 127, 127, 0.35))',
        background: 'var(--color-bg-app, rgba(20, 20, 20, 0.9))',
        color: 'var(--color-text-primary, inherit)',
        overflow: 'hidden',
      }}
    >
      <div
        onPointerDown={startDrag('move')}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 32,
          flexShrink: 0,
          padding: '0 8px',
          cursor: 'move',
          touchAction: 'none',
          userSelect: 'none',
          borderBottom: '1px solid var(--border-subtle, rgba(127, 127, 127, 0.25))',
          fontSize: 12,
        }}
      >
        <span style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {meta.titleZh} <span style={{ opacity: 0.6, fontWeight: 400 }}>{meta.title}</span>
        </span>
        {meta.needsStereo && (
          <span
            title="Needs per-channel data; shows a placeholder on a mono source"
            style={{ fontSize: 10, padding: '1px 4px', borderRadius: 4, background: 'rgba(127, 127, 127, 0.25)', whiteSpace: 'nowrap' }}
          >
            立体声
          </span>
        )}
        <span style={{ flex: 1 }} />
        {meta.hasZoom && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, whiteSpace: 'nowrap' }}>
            <button
              title="Zoom out (wider axis range)"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onZoom(panel.id, zoom / 1.25)}
              style={{ cursor: 'pointer' }}
            >
              −
            </button>
            <span style={{ minWidth: 32, textAlign: 'center' }}>{zoom.toFixed(1)}×</span>
            <button
              title="Zoom in (narrower axis range)"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onZoom(panel.id, zoom * 1.25)}
              style={{ cursor: 'pointer' }}
            >
              +
            </button>
          </span>
        )}
        <button
          title="Remove panel"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onRemove(panel.id)}
          style={{ cursor: 'pointer' }}
        >
          ×
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, padding: 6 }}>
        <MeterCanvas kind={panel.kind} source={source} palette={palette} zoom={zoom} />
      </div>
      <div
        onPointerDown={startDrag('resize')}
        title={snap ? `Resize (snaps to ${WORKSPACE_GRID_PX}px grid)` : 'Resize'}
        style={{
          position: 'absolute',
          right: 0,
          bottom: 0,
          width: 16,
          height: 16,
          cursor: 'nwse-resize',
          touchAction: 'none',
        }}
      />
    </div>
  )
}

/* ── The workspace page ────────────────────────────────────────────────── */

export function MetersPage({ ctx }: { ctx: PluginContextLike }): ReactElement {
  const visualizer = serviceOf<VisualizerServiceLike>(ctx, 'visualizer')
  const source = useMemo(() => createVisualizerFrameSource(visualizer), [visualizer])

  const [workspace, setWorkspace] = useState<Workspace>(() => defaultWorkspace())
  const [storageKind, setStorageKind] = useState<string>('…')
  const [saveStatus, setSaveStatus] = useState<string>('正在加载保存的工作区…')
  const storageRef = useRef<WorkspaceStorage | null>(null)
  const loadedRef = useRef(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

  // Load once: saved workspace wins over the default preset.
  useEffect(() => {
    const storage = resolveWorkspaceStorage(ctx)
    storageRef.current = storage
    setStorageKind(storage.kind)
    void storage
      .load()
      .then((saved) => {
        if (saved) setWorkspace(saved)
        setSaveStatus(
          storage.kind === 'memory'
            ? '仅会话保存（宿主 store 与本地存储均不可用）'
            : `已从${storage.kind === 'store' ? '宿主 store' : '本地存储'}加载`,
        )
      })
      .catch(() => {
        setSaveStatus('加载保存的工作区失败，使用默认布局')
      })
      .finally(() => {
        loadedRef.current = true
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Debounced auto-save on every workspace change after the load.
  useEffect(() => {
    if (!loadedRef.current) return
    const storage = storageRef.current
    if (!storage) return
    const timer = setTimeout(() => {
      void storage
        .save(workspace)
        .then(() => {
          setSaveStatus(
            storage.kind === 'memory'
              ? '已保存（仅本会话）'
              : `已保存到${storage.kind === 'store' ? '宿主 store' : '本地存储'}`,
          )
        })
        .catch(() => setSaveStatus('保存失败'))
    }, 500)
    return () => clearTimeout(timer)
  }, [workspace])

  const applyPreset = useCallback((preset: WorkspacePresetId) => {
    setWorkspace((ws) => WORKSPACE_PRESETS[preset]!.build(ws.palette))
  }, [])

  const exportWorkspace = useCallback(() => {
    const blob = new Blob([serializeWorkspace(workspace)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'visualizer-meters-workspace.json'
    anchor.click()
    URL.revokeObjectURL(url)
  }, [workspace])

  const importWorkspace = useCallback((file: File) => {
    void file.text().then((text) => {
      const parsed = parseWorkspace(text)
      if (!parsed) {
        setSaveStatus('导入失败：文件不是有效的工作区 JSON')
        return
      }
      setWorkspace(parsed)
      setSaveStatus('已导入工作区')
    })
  }, [])

  const containerHeight = Math.max(
    600,
    ...workspace.panels.map((p) => p.y + p.h + 20),
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}>
      <h2 style={{ margin: 0, fontSize: 18 }}>Visualizer Meters</h2>
      <p style={{ margin: 0, fontSize: 12, opacity: 0.75 }}>
        实时可视化工作区：拖动标题栏移动面板，拖右下角缩放面板，
        网格吸附 {WORKSPACE_GRID_PX}px。{visualizer
          ? 'visualizer 服务可用，表头为真实数据。'
          : 'visualizer 服务不可用，表头显示基线。'}
        立体声表头（XY、立体声电平、声场）在当前单声道数据源下显示占位，
        不伪造第二声道——原因见 README 立体声一节。
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 }}>
        <label>
          工作区
          <input
            value={workspace.name}
            onChange={(e) => setWorkspace((ws) => ({ ...ws, name: e.target.value }))}
            style={{ marginLeft: 4, fontSize: 12, padding: '2px 4px', width: 140 }}
          />
        </label>
        <span>预设：</span>
        {(Object.keys(WORKSPACE_PRESETS) as WorkspacePresetId[]).map((preset) => (
          <button key={preset} onClick={() => applyPreset(preset)} style={{ cursor: 'pointer', fontSize: 12 }}>
            {WORKSPACE_PRESETS[preset]!.name}
          </button>
        ))}
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <input
            type="checkbox"
            checked={workspace.snap}
            onChange={(e) => setWorkspace((ws) => ({ ...ws, snap: e.target.checked }))}
          />
          网格吸附
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          Palette
          <select
            value={workspace.palette}
            onChange={(e) =>
              setWorkspace((ws) => ({ ...ws, palette: e.target.value as MetersPaletteName }))
            }
            style={{ fontSize: 12 }}
          >
            {METERS_PALETTES.map((palette) => (
              <option key={palette} value={palette}>
                {palette}
              </option>
            ))}
          </select>
        </label>
        <button onClick={exportWorkspace} style={{ cursor: 'pointer', fontSize: 12 }}>
          导出 JSON
        </button>
        <button onClick={() => fileRef.current?.click()} style={{ cursor: 'pointer', fontSize: 12 }}>
          导入 JSON
        </button>
        <button
          onClick={() => setWorkspace((ws) => WORKSPACE_PRESETS.studio!.build(ws.palette))}
          style={{ cursor: 'pointer', fontSize: 12 }}
        >
          恢复默认布局
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) importWorkspace(file)
            e.target.value = ''
          }}
        />
        <span style={{ opacity: 0.75 }}>
          保存位置：{storageKind} · {saveStatus}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 12 }}>
        <span>添加表头：</span>
        {METER_KINDS.map((kind) => (
          <button
            key={kind}
            onClick={() => setWorkspace((ws) => addPanel(ws, kind))}
            style={{ cursor: 'pointer', fontSize: 12 }}
          >
            {METER_META[kind].titleZh}
          </button>
        ))}
      </div>

      <div
        style={{
          position: 'relative',
          width: '100%',
          height: containerHeight,
          overflow: 'hidden',
          borderRadius: 8,
          border: '1px solid var(--border-subtle, rgba(127, 127, 127, 0.35))',
          backgroundImage: workspace.snap
            ? 'linear-gradient(rgba(127,127,127,0.12) 1px, transparent 1px), linear-gradient(90deg, rgba(127,127,127,0.12) 1px, transparent 1px)'
            : undefined,
          backgroundSize: workspace.snap ? `${WORKSPACE_GRID_PX}px ${WORKSPACE_GRID_PX}px` : undefined,
        }}
      >
        {workspace.panels.length === 0 && (
          <p style={{ padding: 16, fontSize: 12, opacity: 0.75 }}>
            工作区为空：从上方添加一个表头，或载入一个预设。
          </p>
        )}
        {workspace.panels.map((panel, index) => (
          <MeterPanel
            key={panel.id}
            panel={panel}
            zIndex={index}
            snap={workspace.snap}
            palette={workspace.palette}
            source={source}
            onMove={(id, x, y) => setWorkspace((ws) => movePanel(ws, id, x, y))}
            onResize={(id, w, h) => setWorkspace((ws) => resizePanel(ws, id, w, h))}
            onRemove={(id) => setWorkspace((ws) => removePanel(ws, id))}
            onZoom={(id, zoom) => setWorkspace((ws) => setPanelZoom(ws, id, zoom))}
            onFocus={(id) => setWorkspace((ws) => bringToFront(ws, id))}
          />
        ))}
      </div>
      <p style={{ margin: 0, fontSize: 11, opacity: 0.6 }}>
        工作区布局、调色、吸附与缩放由本页保存（见上方保存位置），不走插件配置；
        headless 层的 mode（{DEFAULT_METERS_CONFIG.mode}）/ palette（{DEFAULT_METERS_CONFIG.palette}）解析保持不变，供旧配置兼容。
        倍频程 1/1 与 1/3 切换为面板会话内状态，不随工作区保存。
      </p>
    </div>
  )
}

/* ── Plugin def ─────────────────────────────────────────────────────────── */

export const name = 'bbebee-plugin-visualizer-meters-ui'

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
    yield ctx.ui.registerView('visualizer-meters.page', bound(ctx, MetersPage))
    yield ctx.ui.contribute({
      kind: 'route',
      id: 'visualizer-meters.page',
      path: '/visualizer-meters',
      title: 'Visualizer Meters',
      icon: 'wave-sine',
      placement: ['tray'],
      order: 60,
    })
  }, 'visualizer-meters-ui')
}

export default { name, inject, apply }
