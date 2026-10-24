/**
 * Regression tests for `src/service-of.ts`.
 *
 * The bug: the old lookup fell back to `ctx[key]` when `reflect.get`
 * answered nothing — and on a plugin-scoped cordis context (the only
 * kind a view ever receives) that property access THROWS for any
 * service that was not injected (`cannot get property "x" without
 * inject`). The meters UI injects only `['ui']`, so opening the tray
 * page crashed the render whenever the `visualizer` service was not
 * resolvable, instead of degrading to the quiet baseline the view is
 * designed to draw. A plain-object mock ctx would never catch this:
 * property access answers `undefined` there, which is exactly why the
 * old code passed tests and threw in the app. The stand-in below
 * therefore mimics the scoped proxy, including its throw.
 *
 * Run from the package root:  npm test
 * (equivalently `node --test test/service-of.test.ts` — Node ≥ 22 strips
 * the TypeScript types natively.)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serviceOf } from '../src/service-of.ts'

/**
 * A plugin-scoped cordis context stand-in: `reflect.get(key, false)`
 * answers from the registered services (or `undefined` when absent),
 * while direct property access throws for every key that was not
 * injected — mirroring cordis's proxy in the app.
 */
function scopedCtx(
  services: Record<string, unknown>,
  injected: string[] = ['ui'],
): Record<string, unknown> {
  const reflect = {
    get(key: string, required: boolean): unknown {
      if (key in services) return services[key]
      if (required) throw new Error(`service "${key}" is not registered`)
      return undefined
    },
  }
  return new Proxy(
    { reflect },
    {
      get(target, prop) {
        if (prop === 'reflect') return reflect
        if (typeof prop === 'string' && injected.includes(prop)) {
          return (target as Record<string, unknown>)[prop]
        }
        throw new Error(`cannot get property "${String(prop)}" without inject`)
      },
    },
  ) as Record<string, unknown>
}

test('absent service on a scoped context answers undefined, never throws', () => {
  const ctx = scopedCtx({})
  assert.equal(serviceOf(ctx as never, 'visualizer'), undefined)
})

test('present service is returned through reflect', () => {
  const visualizer = { settings: { fftSize: 256 } }
  const ctx = scopedCtx({ visualizer })
  assert.equal(serviceOf(ctx as never, 'visualizer'), visualizer)
})

test('a context without reflect answers undefined, never throws', () => {
  assert.equal(serviceOf({} as never, 'visualizer'), undefined)
})

test('a throwing reflect degrades to undefined, never throws', () => {
  const ctx = { reflect: { get(): unknown { throw new Error('reflect broken') } } }
  assert.equal(serviceOf(ctx as never, 'visualizer'), undefined)
})

test('a null service answers undefined', () => {
  const ctx = scopedCtx({ visualizer: null })
  assert.equal(serviceOf(ctx as never, 'visualizer'), undefined)
})
