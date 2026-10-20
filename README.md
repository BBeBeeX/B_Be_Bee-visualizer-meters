# Visualizer Meters — a third-party-style BBeBee plugin

This repository is the home of **`@bbebee/plugin-visualizer-meters`**, a
complete, publishable BBeBee plugin package written the way a third-party
author writes one: **one npm package, one `BBeBee.plugin.json`, a headless
entry and a desktop UI entry**, no monorepo wiring. It started life as the
reference example in the BBeBee repository (`examples/visualizer-meters/`)
and is maintained here as its own release repo — copy it as the starting
point for your own plugin.

It adds three audio meters to the now-playing screen — a **spectrogram**
(scrolling waterfall), a **spectrum** (log-spaced frequency bars) and a
**VU meter** (RMS + peak on a dB scale) — all driven by a service it does
not own: the `visualizer` service of the first-party
`@BBeBee/plugin-visualizer` plugin (published to npm as
`@bbebee/plugin-visualizer`).

## What this plugin demonstrates

- **Depending on another plugin's service.** The plugin injects nothing at
  install time it cannot name: the registry entry declares
  `services: ["visualizer"]`, the manifest declares
  `dependencies: ["@BBeBee/plugin-visualizer"]`, and at runtime both halves
  treat the service as *optional* (`ctx.inject(['visualizer'], …)` in the
  headless half; per-frame `serviceOf` reads in the UI) — if the visualizer
  is disabled, the meters idle on a quiet baseline instead of breaking.
- **The combined package shape.** `entry.main` + `entry.ui.desktop` in one
  package; the desktop loader composes them into a single plugin (headless
  first, UI as a child fiber — a broken UI never takes the headless half
  down with it).
- **Host-shared React.** The UI bundle keeps `react`, `react-dom`,
  `react-dom/client`, `react/jsx-runtime` and `react/jsx-dev-runtime`
  external so the shell's import map resolves them to the host's single
  React instance; `package.json` declares the matching
  `peerDependencies` (`^19.0.0`, warn-only at install time). `build.mjs`
  fails the build if a React implementation ever slips into the bundle.
- **Zero capabilities.** `capabilities: []` — the plugin touches no fs,
  network, or database. Its views draw with canvas 2D and host CSS
  variables only; there is no ui-kit import.

## Layout

```
package.json            name/version/files + peerDependencies (the npm face)
BBeBee.plugin.json      the 15-field plugin manifest (name = npm package name, id = unscoped slug)
registry-entry.json     the registry (schema v2) entry — see "Publishing"
build.mjs               esbuild: src/index.ts → dist/index.js,
                        src/ui.tsx → dist/ui-desktop.js, plus the
                        host-sharing assertions on the UI bundle
src/
  config.ts             modes, palettes, defaults, config schema, resolver
  meters-math.ts        pure frame math (levels, VU ballistics, log bands,
                        waterfall ring buffer, palette LUTs)
  index.ts              headless def: config resolution, settings-card
                        contribution, optional visualizer watch
  ui.tsx                UI def: view + settings-card registration into the
                        `now-playing.visualizer` slot; the canvas meters
test/
  meters-math.test.ts   node:test unit tests for the pure modules
```

## How the visualizer service is consumed

The protocol contract (`VisualizerService`) is pull-based — there is no
frame event:

- `visualizer.getFrequencyData(buf)` fills a `Uint8Array` of
  `fftSize / 2` byte bins (0 = silence). The service itself fills zeros
  when no analyser is attached.
- `visualizer.getTimeDomainData(buf)` fills a `Uint8Array` of `fftSize`
  bytes centred on 128 (silence).
- `visualizer.settings.fftSize` (default 128) is the sizing source for
  both buffers; the view re-allocates when it changes.

The view runs one `requestAnimationFrame` loop, pulls one frame per tick,
and stops the loop on unmount. With no service (or no audio) the buffers
stay at their silence values and every meter draws its baseline.

## The three meters

- **Spectrum** — bins are grouped into 48 **logarithmically** spaced bands
  (`logBandEdges` in `meters-math.ts`; pitch perception is logarithmic, so
  linear grouping would waste half the width on bass). Each band shows its
  peak bin, coloured through the active palette.
- **Spectrogram** — every frame becomes one column of a ring buffer
  (`WaterfallBuffer`, 240 columns); new frames enter at the right and
  history scrolls left. Frequencies run bottom (low) to top (high), values
  map through a pseudocolor LUT: `ember` is black → purple → orange →
  yellow, alongside `ice` and `mono`. Rendering goes through an offscreen
  `ImageData` strip scaled up to the canvas.
- **VU** — RMS and peak are computed from the time-domain frame and shown
  on a −60…0 dB scale. Ballistics (`stepVu`, a pure function): the level
  bar attacks instantly and releases at 0.9 dB/frame; the peak marker jumps
  to a new peak, holds ≈45 frames, then falls at 0.35 dB/frame and never
  below the current frame's peak.

Mode and palette can be switched from the segmented control on the view
itself and from the settings card (Settings → Playback → *Visualizer
Meters*); both write to one small store inside the UI bundle.

## Configuration

The plugin accepts a config object (from its registry entry / install
record) of the shape declared in `src/config.ts` (`METERS_CONFIG_SCHEMA`):

```json
{ "mode": "spectrum" | "spectrogram" | "vu", "palette": "ember" | "ice" | "mono" }
```

The headless half resolves the loader-passed config against the defaults
and logs the result. The composed UI def is registered without a config
argument (that is how the loader's composition works today), so the UI
seeds its session state from the same defaults and in-view changes are
session-local. Persisting them across restarts would require a host
storage capability (`db:own`), which this plugin deliberately does not
request.

## Build & test

```bash
npm install   # once — esbuild + type packages from devDependencies
npm run build # → dist/index.js + dist/ui-desktop.js, with assertions
npm test      # node --test over the pure modules — no framework needed
```

`dist/` is a build product (gitignored); `package.json`'s `files` ships
exactly `BBeBee.plugin.json` + `dist`, which is what `npm publish` would
upload.

## Trying it locally

1. `npm install && npm run build` here.
2. Either publish to npm (see below) and install it from the in-app plugin
   market like any registry plugin, or sideload: copy this package
   directory (with its built `dist/`) into the desktop app's
   `installed-plugins/` directory and restart — the loader picks up
   external packages from there, checks the manifest, and composes
   `entry.main` + `entry.ui.desktop`.
3. Play something and open the now-playing screen: the meters view appears
   in the visualizer slot, after the built-in visualizer canvas. (The
   visualizer plugin must be enabled for live data; without it the meters
   draw their idle baseline.)

## Publishing

### 1. Publish the package to npm — from CI, with provenance

Releases are published by `.github/workflows/publish.yml`
(**Actions → Publish to npm → Run workflow**, version as input). The
workflow stamps the version into `package.json` and
`BBeBee.plugin.json`, builds, tests, verifies the publication
identity, and runs `npm publish --provenance`.

Publishing from CI is not a convenience choice: npm **provenance**
attestations — the signed statement of which repository and workflow
built a version — are minted from the GitHub Actions OIDC
environment and cannot be added to a version after the fact. The
0.1.0 launch predates this (local machine, staged publishing) and
carries no attestation; every later release should come from the
workflow. The plugin client refuses an install whose attestation
names a different source repository than the registry entry's
`repo`, and registry CI checks official entries the same way.

One-time setup on npmjs.com (trusted publishing — no long-lived npm
token exists anywhere): package **@bbebee/plugin-visualizer-meters**
→ Settings → Trusted Publisher → GitHub Actions, with organization
`BBeBeeX`, repository `B_Be_Bee-visualizer-meters`, workflow filename
`publish.yml`.

After a release, update the registry entry's pin: set
`reviewedVersion` to the new version and `reviewedIntegrity` to that
version's `dist.integrity` from its npm packument.

Manual publishing (`npm run build && npm publish` from a checkout)
still works in a pinch, but the result has no provenance and should
be replaced by a CI release.

The npm package name and the registry entry's `npm` field are the same
string — `@bbebee/plugin-visualizer-meters` — while the manifest `id`
(and the registry entry's `id`) is the unscoped slug
`bbebee-plugin-visualizer-meters`. The install-time anti-spoofing checks
compare the pairs separately: the published package's name against the
entry's `npm`, its manifest `id` against the entry's `id`.

### 2. Register it in B_Be_Bee-registry

`registry-entry.json` in this repo is the schema-v2 entry for the
community registry. To list the plugin:

1. Copy it into the
   [B_Be_Bee-registry](https://github.com/BBeBeeX/B_Be_Bee-registry) repo
   as `plugins/bbebee-plugin-visualizer-meters.json` (the entry
   filename must equal the entry `id`; registry validation rejects a
   mismatch) and open a PR there.
2. Registry CI validates the entry: field shape, the `services`
   whitelist, and — by fetching the npm packument — that the package in
   the `npm` field exists and that its published manifest id and package
   name match the entry. **Publish to npm first** (step 1); before the
   first publish, validation reports, verbatim:
   `npm package "@bbebee/plugin-visualizer-meters" does not exist on the public npm registry (HTTP 404) — publish it before submitting, or fix the "npm" field`.

Two details of the entry are easy to get wrong:

- **`services: ["visualizer"]`** — passes the registry whitelist because
  `visualizer` is in the registry's core service-key list
  (`scripts/lib/service-keys.ts` in B_Be_Bee-registry); service keys that
  are *not* core keys are covered by the providing entry's `provides`.
- **The dependency names the visualizer's *registry* id.**
  `dependencies: ["bbebeex-visualizer@^0.1.0"]` — a lowercase slug, a
  different namespace from the manifest id (`@BBeBee/plugin-visualizer`)
  that this package's own `BBeBee.plugin.json` `dependencies` uses. The
  registry's dependency grammar (and the client's `parseDepSpecifier`)
  accepts slugs only; writing the manifest-id form here is rejected
  outright (`invalid dependency … — expected "<id>" or
  "<id>@<semver-range>"`). The slug form works because a published
  package's in-package manifest id is stamped to the registry id at
  packaging time, which is exactly what the install-time anti-spoofing
  check compares the entry id against. The dependency is also what makes
  the `services` requirement satisfiable on a fresh install: the
  installer resolves the closure, counts the visualizer entry's declared
  `provides` in its plan-stage availability estimate, and re-verifies the
  downloaded package's manifest `contributes.services` before activating
  anything.

## Notes for authors copying this plugin

- Keep the two halves' shared code inside this package (`src/config.ts`,
  `src/meters-math.ts` are bundled into each entry that imports them).
  Cross-package value imports are not part of the third-party contract.
- If you need the host's exact shared-module list, the single source of
  truth is `apps/desktop/renderer/host-modules.manifest.ts` in the BBeBee
  repo; `build.mjs` mirrors it and says so.
- Log through `ctx.logger`, register cleanup through the fiber/effect
  being disposed, and keep entry points `async` — the loader discards
  disposers returned by plain non-async functions.
