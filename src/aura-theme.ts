/**
 * aura-theme.ts — the AURA visual style, as one set of tokens.
 *
 * The reference is the AURA studio screenshot: a near-black blue-green
 * canvas with soft aurora glows at the edges, dark translucent cards,
 * thin light borders, muted blue-grey secondary text, and a single
 * mint accent for every live line. This module is the only place those
 * values live — `ui.tsx` (panel chrome) and `meters.tsx` (canvas
 * drawing) both read from here, so the style cannot drift apart
 * between chrome and meters.
 *
 * Deliberately CSS-only dark glass: translucent dark panels over a
 * gradient canvas. This is not the platform's native vibrancy/liquid
 * glass (which the mobile work deliberately keeps off large surfaces);
 * it is a self-contained page style that looks the same on any host
 * theme, light or dark. The page therefore forces its own dark
 * container instead of following the host's CSS variables — that
 * break from the previous host-variable styling is intentional, per
 * the request that the workspace look like the AURA figure.
 *
 * Honesty note, kept out of the styling: the top bar's format readout
 * (sample rate, channel count) is rendered from the live `FrameSource`
 * and labelled "assumed" while the source does not report a rate. The
 * style copies the AURA top bar's shape, not its claimed numbers.
 */

import type { CSSProperties } from 'react'

export const AURA = {
  /** Page canvas: deep blue-black with teal/blue aurora glows. */
  pageBackground:
    'radial-gradient(600px 300px at 85% 0%, rgba(94, 234, 200, 0.14), transparent 60%), ' +
    'radial-gradient(700px 400px at 0% 100%, rgba(59, 130, 246, 0.12), transparent 60%), ' +
    'linear-gradient(180deg, #0b1116 0%, #080d11 100%)',
  /** One meter card: dark glass, lighter at the top edge. */
  panelBackground:
    'linear-gradient(180deg, rgba(30, 44, 52, 0.88) 0%, rgba(14, 22, 28, 0.94) 100%)',
  panelBorder: '1px solid rgba(148, 190, 175, 0.16)',
  panelShadow:
    '0 12px 32px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.06)',
  headerBorder: '1px solid rgba(148, 190, 175, 0.12)',
  /** Primary text on dark cards. */
  text: '#e9f6f1',
  /** Secondary labels, axis ticks, readouts. */
  muted: '#93ada4',
  /** Faint text: footnotes, assumed-value notes. */
  faint: 'rgba(147, 173, 164, 0.75)',
  /** The one live accent: mint, for lines, fills and highlights. */
  accent: '#7fe7c4',
  accentSoft: 'rgba(127, 231, 196, 0.55)',
  accentFaint: 'rgba(127, 231, 196, 0.16)',
  /** Canvas grid lines. */
  grid: 'rgba(148, 190, 175, 0.16)',
  gridStrong: 'rgba(148, 190, 175, 0.30)',
  /** Meter track background (level bars). */
  track: 'rgba(255, 255, 255, 0.07)',
  /** Peak markers: warm, as in the reference level meter's hot top. */
  peak: '#ff9a5c',
  peakSoft: 'rgba(255, 154, 92, 0.60)',
  /** Channel traces: bright mint for L / first, deeper teal for R. */
  leftTrace: '#8ff5d2',
  rightTrace: '#5fb99a',
  /** LIVE indicator dot. */
  liveDot: '#4ade80',
} as const

export const auraButtonStyle: CSSProperties = {
  background: 'rgba(255, 255, 255, 0.06)',
  border: '1px solid rgba(148, 190, 175, 0.18)',
  color: AURA.text,
  borderRadius: 8,
  padding: '4px 10px',
  cursor: 'pointer',
  fontSize: 12,
}

export const auraSmallButtonStyle: CSSProperties = {
  background: 'rgba(255, 255, 255, 0.06)',
  border: '1px solid rgba(148, 190, 175, 0.18)',
  color: AURA.text,
  borderRadius: 6,
  padding: '1px 6px',
  cursor: 'pointer',
  fontSize: 12,
  lineHeight: 1.4,
}

export const auraInputStyle: CSSProperties = {
  background: 'rgba(255, 255, 255, 0.06)',
  border: '1px solid rgba(148, 190, 175, 0.18)',
  color: AURA.text,
  borderRadius: 6,
  fontSize: 12,
  padding: '3px 6px',
}

export const auraBadgeStyle: CSSProperties = {
  fontSize: 10,
  padding: '1px 6px',
  borderRadius: 999,
  background: AURA.accentFaint,
  color: AURA.accent,
  border: '1px solid rgba(127, 231, 196, 0.25)',
  whiteSpace: 'nowrap',
}
