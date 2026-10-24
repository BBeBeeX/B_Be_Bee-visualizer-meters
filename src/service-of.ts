/**
 * Opportunistic service lookup for views — a local mirror of
 * `@BBeBee/toolkit/hooks`' `serviceOf(ctx, key)`, kept dependency-free
 * (the UI bundle externalizes only React; see build.mjs).
 *
 * Reflect-only, deliberately. On a plugin-scoped context — which is the
 * only kind a view ever receives — cordis's proxy THROWS for any
 * property that was not injected (`cannot get property "x" without
 * inject`), so a `ctx[key]` fallback turns "service absent" into a
 * render crash. The meters UI injects only `['ui']`, so `ctx.visualizer`
 * always throws there, even when the visualizer service exists in the
 * app. `reflect.get(key, false)` is the ask that has an answer on both
 * root and scoped contexts; absent reflect, a throwing reflect, or an
 * absent service all mean `undefined` here, never a throw — the view
 * then renders its quiet baseline, as designed.
 */

export interface ServiceLookupContext {
  reflect?: {
    get(key: string, required: boolean): unknown
  }
}

export function serviceOf<T>(ctx: ServiceLookupContext, key: string): T | undefined {
  try {
    const value = ctx.reflect?.get(key, false)
    return value === undefined || value === null ? undefined : (value as T)
  } catch {
    return undefined
  }
}
