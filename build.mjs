#!/usr/bin/env node
/* global console, process */
/**
 * build.mjs — builds the two entry bundles of bbebee-plugin-visualizer-meters:
 *
 *   src/index.ts  →  dist/index.js        (headless def, entry.main)
 *   src/ui.tsx    →  dist/ui-desktop.js   (UI def, entry.ui.desktop)
 *
 * The UI bundle is the interesting one: the host shell shares its React
 * with plugin UIs through an import map, so the host-shared specifiers
 * MUST stay external here — a bundled React copy would be a second React
 * instance in the page and hooks/context would silently break. The list
 * below mirrors the single source of truth,
 * `apps/desktop/renderer/host-modules.manifest.ts` (`HOST_MODULES`) in the
 * BBeBee repository; if that list ever changes, change it there first and
 * then here. After bundling, this script asserts the contract on the
 * output (the same gate `scripts/assemble-plugin.mjs` applies to
 * first-party packages):
 *
 *   - no React implementation markers in the UI bundle;
 *   - at least one bare host-module import survived (else there is
 *     nothing for the import map to resolve);
 *   - no host-module import at all in the headless bundle.
 *
 * esbuild is resolved from this package's own node_modules — run
 * `npm install` once before building.
 */

import { createRequire } from 'node:module'
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = dirname(fileURLToPath(import.meta.url))

function loadEsbuild() {
  const require = createRequire(import.meta.url)
  try {
    return require(require.resolve('esbuild', { paths: [join(packageDir, 'node_modules')] }))
  } catch {
    throw new Error('esbuild not found: run `npm install` in this package first.')
  }
}

/**
 * Host-shared specifiers — mirrors HOST_MODULES in
 * apps/desktop/renderer/host-modules.manifest.ts (single source of truth).
 */
const HOST_EXTERNALS = [
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
]

/**
 * Substrings that only appear when a React implementation was bundled.
 * Same marker set as scripts/assemble-plugin.mjs in the BBeBee repo.
 */
const REACT_IMPL_MARKERS = [
  '__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED',
  'ReactCurrentOwner',
  'ReactCurrentDispatcher',
  'react.production',
  'react-dom.production',
  'scheduler.production',
]

function fail(message) {
  console.error(`build: ${message}`)
  process.exit(1)
}

function assertUiBundle(code) {
  for (const marker of REACT_IMPL_MARKERS) {
    if (code.includes(marker)) {
      fail(
        `dist/ui-desktop.js contains React implementation code (marker "${marker}"). ` +
          'The host-shared modules must stay external so the plugin renders against the shell\u2019s single React instance.',
      )
    }
  }
  const bareHostImport = HOST_EXTERNALS.some((s) =>
    new RegExp(`(?:from\\s*|import\\s*)["']${s.replace('/', '\\/')}["']`).test(code),
  )
  if (!bareHostImport) {
    fail(
      `dist/ui-desktop.js contains no bare host-module import (${HOST_EXTERNALS.join(', ')}). ` +
        'A UI bundle that never references the shared modules cannot be checked against the host contract.',
    )
  }
}

function assertHeadlessBundle(code) {
  const hostImport = HOST_EXTERNALS.find((s) =>
    new RegExp(`(?:from\\s*|import\\s*|require\\()["']${s.replace('/', '\\/')}["']`).test(code),
  )
  if (hostImport) {
    fail(
      `dist/index.js imports "${hostImport}" — the headless half must not depend on host UI modules.`,
    )
  }
}

const esbuild = loadEsbuild()

const common = {
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
}

await esbuild.build({
  ...common,
  entryPoints: [join(packageDir, 'src', 'index.ts')],
  outfile: join(packageDir, 'dist', 'index.js'),
})

await esbuild.build({
  ...common,
  entryPoints: [join(packageDir, 'src', 'ui.tsx')],
  outfile: join(packageDir, 'dist', 'ui-desktop.js'),
  external: HOST_EXTERNALS,
  jsx: 'automatic',
})

const { readFileSync } = await import('node:fs')
const uiCode = readFileSync(join(packageDir, 'dist', 'ui-desktop.js'), 'utf8')
const headlessCode = readFileSync(join(packageDir, 'dist', 'index.js'), 'utf8')
assertUiBundle(uiCode)
assertHeadlessBundle(headlessCode)

for (const file of ['index.js', 'ui-desktop.js']) {
  const size = statSync(join(packageDir, 'dist', file)).size
  console.log(`dist/${file}  ${(size / 1024).toFixed(1)} KB`)
}
if (!existsSync(join(packageDir, 'dist', 'index.js'))) fail('dist/index.js missing after build')
console.log('build: ok — UI bundle keeps host modules external, no React implementation inside')
