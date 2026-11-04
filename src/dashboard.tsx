/**
 * dashboard.tsx — the Studio dashboard view for the meters plugin.
 *
 * The reference is the AURA studio figure: a sidebar, a top bar with
 * a LIVE pill and the format readout, and a dashboard of meter cards.
 * This file is only the shell and the card chrome — everything about
 * layout state (drag, resize, snap, presets, save) is the existing
 * workspace model in `./workspace.ts`, shared with the workspace page
 * in `./ui.tsx` (same storage key, so a layout arranged here is the
 * layout that page loads, and vice versa). The workspace page itself
 * is untouched: this view is additive.
 *
 * Honesty notes, kept in the code rather than the docs:
 * - The header shows sample rate and channel count from the live
 *   `FrameSource` (both are live getters now — see `audio-frame.ts`).
 *   It does NOT show a bit depth: no frame carries one, and printing
 *   "24 bit" because the reference figure does would be invented data.
 * - The sidebar's input area names the real input (the `visualizer`
 *   service) and its LIVE state; it does not name an audio device,
 *   because the plugin has no device service to ask.
 * - The light theme recolours the shell only. Meter canvases stay
 *   dark: they are studio surfaces by design (the reference cards are
 *   dark in both of its theme states), and a light canvas would need
 *   a second rendering path per meter.
 * - Card menus contain only actions that exist: bring to front and
 *   remove. There is no decorative menu.
 */

import {
  createElement as h,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { CSSProperties, ReactElement } from 'react'
import {
  METERS_PALETTES,
  type MetersPaletteName,
} from './config.js'
import { createVisualizerFrameSource } from './audio-frame.js'
import type { FrameSource } from './audio-frame.js'
import { serviceOf } from './service-of.js'
import type { ServiceLookupContext } from './service-of.js'
import { MeterCanvas } from './meters.js'
import {
  AURA,
  auraBadgeStyle,
  auraButtonStyle,
  auraInputStyle,
  auraSmallButtonStyle,
} from './aura-theme.js'
import {
  addPanel,
  bringToFront,
  createLocalWorkspaceStorage,
  createMemoryWorkspaceStorage,
  createStoreWorkspaceStorage,
  METER_KINDS,
  METER_META,
  movePanel,
  parseWorkspace,
  removePanel,
  resizePanel,
  serializeWorkspace,
  setPanelZoom,
  studioDashboardWorkspace,
  WORKSPACE_GRID_PX,
  WORKSPACE_PRESETS,
  type MeterKind,
  type Panel,
  type StoreLike,
  type Workspace,
  type WorkspaceStorage,
} from './workspace.js'

/* ── Context surface (structural, same shape as ui.tsx's) ─────────────── */

interface VisualizerServiceLike {
  readonly settings: { fftSize?: number }
  getFrequencyData(array: Uint8Array): void
  getTimeDomainData(array: Uint8Array): void
}

function resolveDashboardStorage(ctx: ServiceLookupContext): WorkspaceStorage {
  const store = serviceOf<StoreLike>(ctx, 'store')
  if (store && typeof store.get === 'function' && typeof store.set === 'function') {
    return createStoreWorkspaceStorage(store)
  }
  return createLocalWorkspaceStorage() ?? createMemoryWorkspaceStorage()
}

/* ── Shell theme: dark is the reference; light recolours chrome only ──── */

interface ShellTheme {
  pageBackground: string
  sidebarBackground: string
  headerBackground: string
  text: string
  muted: string
  faint: string
  border: string
  cardBackground: string
  hoverBackground: string
}

const DARK_SHELL: ShellTheme = {
  pageBackground: AURA.pageBackground,
  sidebarBackground: 'rgba(10, 17, 22, 0.92)',
  headerBackground: 'rgba(14, 22, 28, 0.85)',
  text: AURA.text,
  muted: AURA.muted,
  faint: AURA.faint,
  border: 'rgba(148, 190, 175, 0.16)',
  cardBackground: AURA.panelBackground,
  hoverBackground: 'rgba(255, 255, 255, 0.08)',
}

const LIGHT_SHELL: ShellTheme = {
  pageBackground: 'linear-gradient(180deg, #eef2f4 0%, #e2e9ec 100%)',
  sidebarBackground: 'rgba(255, 255, 255, 0.85)',
  headerBackground: 'rgba(255, 255, 255, 0.85)',
  text: '#16232b',
  muted: '#5a7079',
  faint: 'rgba(90, 112, 121, 0.75)',
  border: 'rgba(22, 35, 43, 0.14)',
  cardBackground: 'linear-gradient(180deg, rgba(255,255,255,0.9) 0%, rgba(240,245,247,0.94) 100%)',
  hoverBackground: 'rgba(22, 35, 43, 0.06)',
}

/* ── One dashboard card: same drag/resize model as the workspace page ─── */

interface DashboardCardProps {
  panel: Panel
  zIndex: number
  snap: boolean
  palette: MetersPaletteName
  source: FrameSource
  shell: ShellTheme
  onMove: (id: string, x: number, y: number) => void
  onResize: (id: string, w: number, h: number) => void
  onRemove: (id: string) => void
  onZoom: (id: string, zoom: number) => void
  onFocus: (id: string) => void
}

function DashboardCard({
  panel,
  zIndex,
  snap,
  palette,
  source,
  shell,
  onMove,
  onResize,
  onRemove,
  onZoom,
  onFocus,
}: DashboardCardProps): ReactElement {
  const meta = METER_META[panel.kind]
  const [menuOpen, setMenuOpen] = useState(false)
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
      className="dash-card"
      style={{
        position: 'absolute',
        left: panel.x,
        top: panel.y,
        width: panel.w,
        height: panel.h,
        zIndex,
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 16,
        border: `1px solid ${shell.border}`,
        background: shell.cardBackground,
        boxShadow: AURA.panelShadow,
        color: shell.text,
        overflow: 'hidden',
      }}
    >
      <div
        onPointerDown={startDrag('move')}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 34,
          flexShrink: 0,
          padding: '0 10px',
          cursor: 'move',
          touchAction: 'none',
          userSelect: 'none',
          borderBottom: `1px solid ${shell.border}`,
          fontSize: 12,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: AURA.accent,
            boxShadow: '0 0 8px rgba(127, 231, 196, 0.8)',
            flexShrink: 0,
          }}
        />
        <span style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {meta.titleZh} <span style={{ opacity: 0.6, fontWeight: 400 }}>{meta.title}</span>
        </span>
        {meta.needsStereo && (
          <span
            title="Needs per-channel data; shows a placeholder on a mono source"
            style={auraBadgeStyle}
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
              style={auraSmallButtonStyle}
            >
              −
            </button>
            <span style={{ minWidth: 32, textAlign: 'center' }}>{zoom.toFixed(1)}×</span>
            <button
              title="Zoom in (narrower axis range)"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onZoom(panel.id, zoom * 1.25)}
              style={auraSmallButtonStyle}
            >
              +
            </button>
          </span>
        )}
        <span style={{ position: 'relative' }}>
          <button
            title="卡片操作"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setMenuOpen((open) => !open)}
            style={auraSmallButtonStyle}
          >
            ⋯
          </button>
          {menuOpen && (
            <span
              style={{
                position: 'absolute',
                right: 0,
                top: 24,
                zIndex: 10,
                display: 'flex',
                flexDirection: 'column',
                minWidth: 110,
                padding: 4,
                borderRadius: 8,
                border: `1px solid ${shell.border}`,
                background: shell.sidebarBackground,
                boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
              }}
            >
              <button
                onClick={() => {
                  onFocus(panel.id)
                  setMenuOpen(false)
                }}
                style={{ ...auraSmallButtonStyle, border: 'none', textAlign: 'left' }}
              >
                置于顶层
              </button>
              <button
                onClick={() => {
                  onRemove(panel.id)
                  setMenuOpen(false)
                }}
                style={{ ...auraSmallButtonStyle, border: 'none', textAlign: 'left' }}
              >
                移除面板
              </button>
            </span>
          )}
        </span>
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

/* ── The dashboard page ────────────────────────────────────────────────── */

type DrawerId = 'workspace' | 'modules' | 'presets' | 'settings' | 'about'

const NAV_ITEMS: Array<{ id: DrawerId; zh: string; en: string }> = [
  { id: 'workspace', zh: '工作区', en: 'Workspace' },
  { id: 'modules', zh: '模块', en: 'Modules' },
  { id: 'presets', zh: '预设', en: 'Presets' },
  { id: 'settings', zh: '设置', en: 'Settings' },
  { id: 'about', zh: '关于', en: 'About' },
]

type DashboardPresetId = 'studio' | 'compact' | 'monitor'

const DASHBOARD_PRESETS: Record<DashboardPresetId, { name: string; build: (palette: Workspace['palette']) => Workspace }> = {
  studio: {
    name: 'Studio',
    build: (palette) => studioDashboardWorkspace(palette),
  },
  compact: {
    name: 'Compact',
    build: (palette) => WORKSPACE_PRESETS.aura!.build(palette),
  },
  monitor: {
    name: 'Monitor',
    build: (palette) => WORKSPACE_PRESETS['signal-scope']!.build(palette),
  },
}

export function DashboardPage({ ctx }: { ctx: ServiceLookupContext }): ReactElement {
  const visualizer = serviceOf<VisualizerServiceLike>(ctx, 'visualizer')
  const source = useMemo(() => createVisualizerFrameSource(visualizer), [visualizer])

  const [workspace, setWorkspace] = useState<Workspace>(() => studioDashboardWorkspace('aura'))
  const [storageKind, setStorageKind] = useState<string>('…')
  const [saveStatus, setSaveStatus] = useState<string>('正在加载保存的工作区…')
  const storageRef = useRef<WorkspaceStorage | null>(null)
  const loadedRef = useRef(false)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const [drawer, setDrawer] = useState<DrawerId>('workspace')
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [isFullscreen, setIsFullscreen] = useState(false)
  // 1 Hz refresh for the header readouts only (rate/channels are live
  // getters; the header must re-render to show a change). Meter
  // canvases run their own rAF loops and are unaffected.
  const [, setHeaderTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setHeaderTick((t) => t + 1), 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  // Load once: a saved workspace wins over the Studio default.
  useEffect(() => {
    const storage = resolveDashboardStorage(ctx)
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

  const applyPreset = useCallback((preset: DashboardPresetId) => {
    setWorkspace((ws) => DASHBOARD_PRESETS[preset]!.build(ws.palette))
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

  const toggleFullscreen = useCallback(() => {
    const root = rootRef.current
    if (!root) return
    if (document.fullscreenElement) {
      void document.exitFullscreen()
    } else {
      void root.requestFullscreen()
    }
  }, [])

  const containerHeight = Math.max(
    600,
    ...workspace.panels.map((p) => p.y + p.h + 20),
  )

  const shell = theme === 'dark' ? DARK_SHELL : LIGHT_SHELL
  const live = source.available
  const rateLabel = source.sampleRateHz
    ? `${(source.sampleRateHz / 1000).toFixed(0)} kHz`
    : '–'
  const channelsLabel = source.channels === 2 ? 'Stereo' : 'Mono'

  const navButtonStyle = (active: boolean): CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    padding: '8px 12px',
    borderRadius: 8,
    border: '1px solid transparent',
    background: active ? 'rgba(127, 231, 196, 0.14)' : 'transparent',
    color: active ? shell.text : shell.muted,
    cursor: 'pointer',
    fontSize: 13,
    textAlign: 'left',
  })

  return (
    <div
      ref={rootRef}
      style={{
        display: 'flex',
        width: '100%',
        minHeight: 600,
        background: shell.pageBackground,
        color: shell.text,
        borderRadius: 20,
        overflow: 'hidden',
        boxSizing: 'border-box',
        // CSS variables for the hover rules in the <style> block below.
        ['--dash-muted' as string]: shell.muted,
        ['--dash-hover' as string]: shell.hoverBackground,
        ['--dash-border' as string]: shell.border,
      }}
    >
      <style>{`
        .dash-nav:hover { background: var(--dash-hover) !important; }
        .dash-card:hover { border-color: rgba(127, 231, 196, 0.45) !important; }
        .dash-btn:hover { background: var(--dash-hover) !important; }
      `}</style>

      {/* ── Sidebar ─────────────────────────────────────────── */}
      <aside
        style={{
          width: 200,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          padding: 16,
          background: shell.sidebarBackground,
          borderRight: `1px solid ${shell.border}`,
          boxSizing: 'border-box',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 4px 14px' }}>
          <span style={{ fontSize: 22, color: AURA.accent }}>▮▮▮</span>
          <span>
            <span style={{ display: 'block', fontSize: 16, fontWeight: 700, letterSpacing: 1 }}>AURA</span>
            <span style={{ display: 'block', fontSize: 11, color: shell.muted }}>
              See sound differently.
            </span>
          </span>
        </div>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            className="dash-nav"
            onClick={() => setDrawer(item.id)}
            style={navButtonStyle(drawer === item.id)}
          >
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: drawer === item.id ? AURA.accent : shell.muted, flexShrink: 0 }} />
            {item.zh}
            <span style={{ opacity: 0.6, fontSize: 11 }}>{item.en}</span>
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <div
          style={{
            padding: 12,
            borderRadius: 12,
            border: `1px solid ${shell.border}`,
            fontSize: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <span style={{ color: shell.muted }}>音频输入</span>
          <span>{visualizer ? 'visualizer 服务' : '无服务（基线显示）'}</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: live ? '#bbf7d0' : shell.muted }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: live ? AURA.liveDot : shell.muted }} />
            {live ? 'LIVE' : '离线'}
          </span>
          <span style={{ color: shell.muted }}>
            {rateLabel} · {channelsLabel}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6, paddingTop: 8 }}>
          <button
            className="dash-btn"
            onClick={() => setTheme('dark')}
            style={{ ...auraButtonStyle, flex: 1, background: theme === 'dark' ? 'rgba(127, 231, 196, 0.14)' : auraButtonStyle.background, color: shell.text }}
          >
            Dark
          </button>
          <button
            className="dash-btn"
            onClick={() => setTheme('light')}
            style={{ ...auraButtonStyle, flex: 1, background: theme === 'light' ? 'rgba(127, 231, 196, 0.14)' : auraButtonStyle.background, color: shell.text }}
          >
            Light
          </button>
        </div>
      </aside>

      {/* ── Main column ─────────────────────────────────────── */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '12px 16px',
            background: shell.headerBackground,
            borderBottom: `1px solid ${shell.border}`,
            flexWrap: 'wrap',
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16 }}>{workspace.name} Workspace</h2>
          <span style={{ fontSize: 12, color: shell.muted }}>▾ 布局切换见预设</span>
          <span style={{ flex: 1 }} />
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 11,
              padding: '3px 10px',
              borderRadius: 999,
              border: live ? '1px solid rgba(74, 222, 128, 0.4)' : `1px solid ${shell.border}`,
              background: live ? 'rgba(74, 222, 128, 0.12)' : 'rgba(255, 255, 255, 0.05)',
              color: live ? '#bbf7d0' : shell.muted,
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: live ? AURA.liveDot : shell.muted }} />
            {live ? 'LIVE' : '离线'}
          </span>
          <span style={{ fontSize: 12, color: shell.muted }}>
            {rateLabel} · {channelsLabel}
          </span>
          {(Object.keys(DASHBOARD_PRESETS) as DashboardPresetId[]).map((preset) => (
            <button key={preset} onClick={() => applyPreset(preset)} style={{ ...auraButtonStyle, color: shell.text }}>
              {DASHBOARD_PRESETS[preset]!.name}
            </button>
          ))}
          <button onClick={toggleFullscreen} style={{ ...auraButtonStyle, color: shell.text }} title="全屏工作模式">
            {isFullscreen ? '退出全屏' : '全屏'}
          </button>
        </header>

        {/* ── Drawer: real controls, switched by the sidebar ─── */}
        {drawer !== 'workspace' && (
          <div style={{ padding: '12px 16px', borderBottom: `1px solid ${shell.border}`, fontSize: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {drawer === 'modules' && (
              <>
                <span>添加表头：</span>
                {METER_KINDS.map((kind) => (
                  <button key={kind} onClick={() => setWorkspace((ws) => addPanel(ws, kind))} style={{ ...auraButtonStyle, color: shell.text }}>
                    {METER_META[kind].titleZh}
                  </button>
                ))}
              </>
            )}
            {drawer === 'presets' && (
              <>
                <span>预设：</span>
                <button onClick={() => applyPreset('studio')} style={{ ...auraButtonStyle, color: shell.text }}>Studio（全部 11 表）</button>
                <button onClick={() => applyPreset('compact')} style={{ ...auraButtonStyle, color: shell.text }}>Compact（AURA 6 表）</button>
                <button onClick={() => applyPreset('monitor')} style={{ ...auraButtonStyle, color: shell.text }}>Monitor（SignalScope 5 表）</button>
                <span style={{ color: shell.faint }}>预设切换会替换当前布局；保存是自动的，可导出 JSON 备份。</span>
              </>
            )}
            {drawer === 'settings' && (
              <>
                <label>
                  工作区
                  <input
                    value={workspace.name}
                    onChange={(e) => setWorkspace((ws) => ({ ...ws, name: e.target.value }))}
                    style={{ ...auraInputStyle, marginLeft: 4, width: 140, color: shell.text }}
                  />
                </label>
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
                    style={{ ...auraInputStyle, color: shell.text }}
                  >
                    {METERS_PALETTES.map((palette) => (
                      <option key={palette} value={palette}>
                        {palette}
                      </option>
                    ))}
                  </select>
                </label>
                <button onClick={exportWorkspace} style={{ ...auraButtonStyle, color: shell.text }}>导出 JSON</button>
                <button onClick={() => fileRef.current?.click()} style={{ ...auraButtonStyle, color: shell.text }}>导入 JSON</button>
                <button onClick={() => setWorkspace((ws) => studioDashboardWorkspace(ws.palette))} style={{ ...auraButtonStyle, color: shell.text }}>
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
                <span style={{ color: shell.faint }}>
                  保存位置：{storageKind} · {saveStatus}
                </span>
              </>
            )}
            {drawer === 'about' && (
              <span style={{ color: shell.muted, lineHeight: 1.6 }}>
                AURA Studio Dashboard — bbebee-plugin-visualizer-meters 的工作站视图。
                全部表头读真实 visualizer 服务数据；响度为近似值（无 K 计权、单声道字节数据）；
                立体声表头在单声道源下显示占位，不伪造第二声道；顶栏不显示位深，因为帧数据不携带位深；
                浅色主题只换壳颜色，表头画布保持深色工作台面。
              </span>
            )}
          </div>
        )}

        {/* ── Canvas: the shared free-position workspace ─────── */}
        <div
          style={{
            position: 'relative',
            width: '100%',
            height: containerHeight,
            overflow: 'hidden',
            backgroundColor: 'rgba(0, 0, 0, 0.25)',
            backgroundImage: workspace.snap
              ? 'linear-gradient(rgba(148,190,175,0.10) 1px, transparent 1px), linear-gradient(90deg, rgba(148,190,175,0.10) 1px, transparent 1px)'
              : undefined,
            backgroundSize: workspace.snap ? `${WORKSPACE_GRID_PX}px ${WORKSPACE_GRID_PX}px` : undefined,
          }}
        >
          {workspace.panels.length === 0 && (
            <p style={{ padding: 16, fontSize: 12, color: shell.muted }}>
              工作区为空：从左侧“模块”添加一个表头，或载入一个预设。
            </p>
          )}
          {workspace.panels.map((panel, index) => (
            <DashboardCard
              key={panel.id}
              panel={panel}
              zIndex={index}
              snap={workspace.snap}
              palette={workspace.palette}
              source={source}
              shell={shell}
              onMove={(id, x, y) => setWorkspace((ws) => movePanel(ws, id, x, y))}
              onResize={(id, w, h) => setWorkspace((ws) => resizePanel(ws, id, w, h))}
              onRemove={(id) => setWorkspace((ws) => removePanel(ws, id))}
              onZoom={(id, zoom) => setWorkspace((ws) => setPanelZoom(ws, id, zoom))}
              onFocus={(id) => setWorkspace((ws) => bringToFront(ws, id))}
            />
          ))}
        </div>
        <p style={{ margin: 0, padding: '10px 16px', fontSize: 11, color: shell.faint }}>
          拖动标题栏移动卡片，拖右下角缩放卡片，网格吸附 {WORKSPACE_GRID_PX}px。
          布局与工作区页面共享同一保存位置；倍频程 1/1 与 1/3 切换为面板会话内状态，不随工作区保存。
        </p>
      </div>
    </div>
  )
}

export default { DashboardPage }
