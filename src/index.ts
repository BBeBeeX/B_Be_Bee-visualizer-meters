/**
 * bbebee-plugin-visualizer-meters — headless half.
 *
 * A third-party-style example plugin: it provides no service of its own and
 * draws nothing by itself. Its jobs are to
 *
 * 1. declare and resolve the plugin's configuration (defaults + schema in
 *    `./config.js`) from whatever config the loader hands `apply()`, and
 * 2. note when the `visualizer` service it depends on becomes available
 *    (as an optional dependency, so disabling the visualizer plugin idles
 *    this one instead of wedging the load order).
 *
 * The interesting half — spectrogram / spectrum / VU views consuming the
 * `visualizer` service, presented as a tray-navigated page — lives in
 * `./ui.tsx`.
 *
 * This module is a plain Cordis plugin def: a structural object, no Cordis
 * runtime import. The minimal context surface it uses is typed locally
 * below; authors building inside the BBeBee monorepo can swap these for the
 * `@BBeBee/protocol` / `@BBeBee/kernel` types.
 */

import {
  DEFAULT_METERS_CONFIG,
  METERS_CONFIG_SCHEMA,
  resolveMetersConfig,
  type MetersConfig,
} from './config.js'

/* ── Minimal host context surface (structural, no runtime imports) ────── */

interface LoggerLike {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
}

/** The slice of the visualizer service this plugin reads (see ui.tsx). */
interface VisualizerServiceLike {
  readonly settings: { fftSize?: number }
}

interface ScopedContextLike {
  logger: LoggerLike
  visualizer?: VisualizerServiceLike
  effect(fn: unknown, name?: string): unknown
}

interface PluginContextLike extends ScopedContextLike {
  inject(deps: readonly string[], callback: (scoped: ScopedContextLike) => void): void
}

/* ── Plugin def ─────────────────────────────────────────────────────────── */

export const name = 'bbebee-plugin-visualizer-meters'

/**
 * No hard dependencies are declared here on purpose. The plugin's real
 * dependency — the `visualizer` service — is declared where install-time
 * guarantees live (the manifest `dependencies` and the registry entry's
 * `services`), and consumed at runtime as an *optional* dependency via
 * `ctx.inject([...], …)`, the repo's convention for optional services: if
 * the user disables the visualizer plugin, this plugin idles instead of
 * wedging the load order, and starts working the moment the service
 * appears.
 */
export const inject: readonly string[] = []

/** Re-exported so hosts/tooling can introspect the accepted config shape. */
export const configSchema = METERS_CONFIG_SCHEMA
export { DEFAULT_METERS_CONFIG, type MetersConfig }

export async function apply(ctx: PluginContextLike, config?: unknown) {
  const resolved: MetersConfig = resolveMetersConfig(config)
  ctx.logger.info(
    `visualizer-meters: loaded (default mode=${resolved.mode}, palette=${resolved.palette})`,
  )

  // Optional dependency, repo convention: react to the visualizer service
  // appearing/disappearing instead of hard-injecting it. Here the headless
  // half only notes readiness; the views read frames from the same service.
  ctx.inject(['visualizer'], (scoped) => {
    const fftSize = scoped.visualizer?.settings?.fftSize
    scoped.logger.info(
      `visualizer-meters: visualizer service available${fftSize ? ` (fftSize=${fftSize})` : ''}`,
    )
  })

  return () => {
    ctx.logger.info('visualizer-meters: disposed')
  }
}

export default { name, inject, apply }
