# Visualizer Meters — a third-party-style BBeBee plugin

This repository is the home of **`@bbebee/plugin-visualizer-meters`**, a
complete, publishable BBeBee plugin package written the way a third-party
author writes one: **one npm package, one `BBeBee.plugin.json`, a headless
entry and a desktop UI entry**, no monorepo wiring. It started life as the
reference example in the BBeBee repository (`examples/visualizer-meters/`)
and is maintained here as its own release repo — copy it as the starting
point for your own plugin.

It adds a Visualizer Meters workspace page, reached from the plugin tray, with ten independent audio meters — the SignalScope XM set (FFT Analyzer, Oscilloscope, Octave Analyzer, Spectrogram, XY Scope) and the AURA set (Spectrum Analyzer, Waveform, Stereo Level Meter, Loudness Meter, Stereo Field, Spectrogram shared) — all driven by a service it does not own: the `visualizer` service of the first-party
`@BBeBee/plugin-visualizer` plugin (published to npm as
`@bbebee/plugin-visualizer`). Panels drag, resize, snap to a 20 px grid, and save as a workspace (see "The workspace" below).

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
                        octave bands, stereo levels, loudness, waterfall
                        ring buffer, palette LUTs)
  audio-frame.ts        the real-time data interface: AudioFrame,
                        FrameSource, the mono visualizer adapter, and the
                        waveform TimeHistory (see below)
  workspace.ts          workspace layout model, presets, validation and
                        storage (pure — no DOM, unit-tested)
  meters.tsx            the ten independent meter components, each with
                        its own canvas and animation loop
  index.ts              headless def: config resolution, optional
                        visualizer watch
  ui.tsx                UI def: workspace page registered as a tray route;
                        panel chrome (drag / resize / zoom / save)
test/
  meters-math.test.ts   node:test unit tests for the pure modules
  workspace.test.ts     node:test unit tests for the workspace model,
                        the frame adapter and the new meter math
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

## The ten meters

Every meter is an independent component in `src/meters.tsx`: it takes a
`FrameSource`, pulls one frame per animation tick, and draws its own
canvas. The workspace only composes them.

- **FFT Analyzer** — per-bin magnitude line on a dB scale (engine-mapped
  −100…−30 dB), log frequency axis, slow-falling peak line. Zoom narrows
  the visible frequency range.
- **Spectrum Analyzer** — bins grouped into 48 **logarithmically** spaced
  bands (`logBandEdges`; pitch perception is logarithmic, so linear
  grouping would waste half the width on bass). Each band shows its peak
  bin, coloured through the active palette. This is the old "Spectrum"
  mode, kept as its own component: bars for at-a-glance levels, the FFT
  line for analysis detail.
- **Octave Analyzer** — 1/1- or 1/3-octave bands (toggle on the panel)
  with centre-frequency labels. Bands narrower than one FFT bin are
  dropped, not drawn as lying bars — at the default fftSize of 128 the
  low octaves simply do not exist, and the panel says to raise fftSize.
- **Spectrogram** — every frame becomes one column of a ring buffer
  (`WaterfallBuffer`, 240 columns × 64 log-frequency rows); new frames
  enter at the right and history scrolls left. Frequencies run bottom
  (low) to top (high), values map through a pseudocolor LUT: `ember` is
  black → purple → orange → yellow, alongside `ice` and `mono`.
  Rendering goes through an offscreen `ImageData` strip scaled up to
  the canvas. Zoom crops to the low-frequency rows.
- **Oscilloscope** — the latest time-domain frame, channels overlaid,
  with an ms time axis. Zoom shows the first part of the frame in
  detail.
- **Waveform** — scrolling history of time-domain frames (a
  `TimeHistory` ring, channels stacked when stereo). The history is
  frame-stitched — the analyser hands out its latest FFT window per
  tick, not a guaranteed-contiguous PCM stream — so the time axis is
  approximate and labelled as such.
- **XY Scope** — Lissajous plot, left against right, with correlation
  and width readouts. Stereo only (see below).
- **Stereo Level Meter** — per-channel RMS + peak bars on a −60…0 dB
  scale. Ballistics (`stepVu`, a pure function): the level bar attacks
  instantly and releases at 0.9 dB/frame; the peak marker jumps to a new
  peak, holds ≈45 frames, then falls at 0.35 dB/frame and never below
  the current frame's peak. Stereo only (see below).
- **Loudness Meter** — momentary (τ 400 ms), short-term (τ 3 s) and
  integrated loudness plus a windowed loudness range, stepped at
  ~10 Hz. **These numbers are approximate, not BS.1770**: the input is
  8-bit mono byte data with no K-weighting filter and no channel
  weighting (see `meters-math.ts` for the exact simplifications). The
  panel says so; do not quote them as certified LUFS.
- **Stereo Field** — goniometer: mid vertical, side horizontal, as a
  dot cloud (not a time-ordered polyline, which would draw chords the
  field does not contain), plus width and correlation. Stereo only
  (see below).

## Visual style: AURA

The page is styled after the AURA studio figure, and the style is
deliberate, not host-following: a near-black blue-green canvas with
soft aurora glows, dark translucent cards (16 px radius, thin light
border, soft shadow), muted blue-grey secondary text, and one mint
accent for every live line. All values live in one place
(`src/aura-theme.ts`), shared by the panel chrome and the canvas
drawing, so chrome and meters cannot drift apart.

Consequences worth knowing:

- The page forces its own dark container and no longer follows the
  host's CSS variables. On a light host theme the workspace still
  looks like the figure — that break is intentional.
- The default palette is now `aura` (dark teal → mint); `ember`,
  `ice` and `mono` remain selectable, and old saved workspaces with
  those palettes still validate.
- The top bar copies the figure's shape (workspace name, LIVE pill,
  format readout) but not its claimed numbers: the readout is rendered
  from the live `FrameSource` — sample rate labelled "assumed" while
  the source does not report one, channel count as Mono until a stereo
  source exists. No bit depth is shown, because no layer reports one.
- The glass here is CSS-only (translucent dark panels over a gradient
  canvas), not platform vibrancy — the same restraint the mobile work
  applies to large surfaces, kept for a desktop page that must look
  identical on any host.

## The workspace

The page is a free canvas of panels, not a fixed grid:

- **Drag** a panel by its title bar; **resize** by its bottom-right
  corner. Panels may overlap; array order is z-order, and clicking a
  panel brings it to front.
- **Grid snap** (20 px, toggleable) applies to both drag and resize,
  and the canvas shows the grid while it is on.
- **Zoom** (− / + on panels that have an axis) scales that meter's
  axis — frequency range for FFT / spectrum / octave / spectrogram,
  time window for oscilloscope / waveform. Meters without an axis have
  no zoom control, rather than one that does nothing.
- **Presets**: SignalScope (the five SignalScope XM meters), AURA (the
  six AURA meters), Studio (all ten). Any panel can be added again from
  the "add meter" row — composition is not limited to one of each.
- **Save**: layout, palette, snap and zoom auto-save (debounced) to
  the host store when the view can reach one (`ctx.store`, the
  namespaced key/value service first-party plugins already use for
  small state — no manifest capability is needed for a blob this
  size), else to `localStorage`, else for the session only. The page
  always shows which backend is in effect. JSON export/import always
  works, so a workspace is never trapped in one backend. Imported
  JSON is validated: unknown kinds are dropped, bad numbers fall back
  to safe defaults, duplicate ids are de-duplicated.

## The real-time data interface (`src/audio-frame.ts`)

Meters never touch the `visualizer` service directly. They consume an
`AudioFrame` through a `FrameSource`:

- `frequencyData` / `timeDomainData`: the mono mix (or channel 0), in
  AnalyserNode byte conventions.
- `left` / `right`: per-channel byte data — **absent today**, and the
  interface says so instead of faking it.
- `sampleRateHz`: **absent today**. Meters that need it (octave bands,
  oscilloscope milliseconds) assume 48 kHz and label the assumption on
  the panel.

The only adapter that exists today,
`createVisualizerFrameSource`, wraps the existing mono service. When a
stereo source exists it implements the same interface and no meter
changes.

## Stereo data: what audio-engine must change

**Yes, audio-engine must change for true stereo meters — but not for
anything in this change.** The chain today is mono end to end, and no
meters-side code can recover what was discarded upstream:

1. `audio-engine`'s `FftProcessor::processInterleaved` downmixes every
   channel to mono before the FFT, and the NDJSON `fft-frame` carries
   only that mono pair. The minimal engine change is to keep
   per-channel time-domain data and per-channel FFT (or at least
   per-channel levels + a stereo PCM tap), and to emit them in the
   frame — plus the sample rate, which no layer currently exposes.
2. `plugin-visualizer`'s `NativeMpvImpl` (BBeBee repo) must forward
   the per-channel frame instead of smoothing only the mono spectrum,
   and the `VisualizerService` protocol must gain the stereo fields
   (the shape in `audio-frame.ts` is the proposal).
3. The Web Audio path needs the same treatment: an `AnalyserNode`
   alone does not give per-channel data either, so a stereo source
   there means a splitter + two analysers, or a worklet tap.

Until that chain lands, the XY scope, stereo level meter and stereo
field render an explicit "needs stereo data" placeholder on the mono
source. Copying the mono mix to both channels would draw a perfect
diagonal and a zero-width field — a lie that looks like data — so it
is deliberately not done. Likewise, a sample-accurate oscilloscope
needs the same PCM tap, not analyser windows.

This change touches **only** the meters repo. No audio-engine or
BBeBee change is included, and none is needed for the mono meters,
the workspace, or the frame interface itself.

## Configuration

The plugin accepts a config object (from its registry entry / install
record) of the shape declared in `src/config.ts` (`METERS_CONFIG_SCHEMA`):

```json
{ "mode": "spectrum" | "spectrogram" | "vu", "palette": "ember" | "ice" | "mono" }
```

The headless half resolves the loader-passed config against the defaults
and logs the result. The composed UI def is registered without a config
argument (that is how the loader's composition works today). The old
`mode` field is now legacy — the UI no longer has a single mode, it has
panels — but the resolver keeps accepting it so old registry entries
still validate. Palette, layout, snap and zoom live in the workspace
and are saved as described in "The workspace" above (host store first,
no `db:own` capability needed for a blob this size); the per-panel
octave toggle (1/1 vs 1/3) is the one control that stays session-local.

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
3. Play something and open the Visualizer Meters page from the plugin tray.
   (The visualizer plugin must be enabled for live data; without it the
   meters draw their idle baseline.)

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

The npm package name, the registry entry's `npm` field, the manifest
`id` and the registry entry's `id` are one identity —
`@bbebee/plugin-visualizer-meters`. The install-time anti-spoofing checks
compare the pairs separately: the published package's name against the
entry's `npm`, its manifest `id` against the entry's `id` (they are the
same string in both pairs now).

### 2. Register it in B_Be_Bee-registry

`registry-entry.json` in this repo is the schema-v2 entry for the
community registry. To list the plugin:

1. Copy it into the
   [B_Be_Bee-registry](https://github.com/BBeBeeX/B_Be_Bee-registry) repo
   as `plugins/bbebee-plugin-visualizer-meters.json` (the entry
   filename must equal the entry `id`'s file stem — the scoped id with
   `@` stripped and `/` replaced by `-`; registry validation rejects a
   mismatch) and open a PR there.
2. Registry CI validates the entry: field shape, the `services`
   whitelist, and — by fetching the npm packument — that the package in
   the `npm` field exists and that its published manifest id and package
   name match the entry. **Publish to npm first** (step 1); before the
   first publish, validation reports, verbatim:
   `npm package "@bbebee/plugin-visualizer-meters" does not exist on the public npm registry (HTTP 404) — publish it before submitting, or fix the "npm" field`.

Two details of the entry are easy to get wrong:

- **`npmUrl`** — the entry's canonical npm package address, derived from
  `npm` (`https://registry.npmjs.org/<encodeURIComponent(npm)>`, here
  `https://registry.npmjs.org/%40bbebee%2Fplugin-visualizer-meters`).
  It carries neither a version (it addresses the package, not a
  release) nor a hash, and registry CI rejects any value other than
  the exact derivation. Normally clients resolve downloads through
  their effective registry (mirror-aware); when that download proves
  ineffective, the client falls back to this address, re-resolving
  the plan's exact version from the official packument.
- **`services: ["visualizer"]`** — passes the registry whitelist because
  `visualizer` is in the registry's core service-key list
  (`scripts/lib/service-keys.ts` in B_Be_Bee-registry); service keys that
  are *not* core keys are covered by the providing entry's `provides`.
- **The dependency names the visualizer's *registry* id, which is
  also its manifest id and npm name.**
  `dependencies: ["@bbebee/plugin-visualizer@^0.1.0"]` — the same
  string this package's own `BBeBee.plugin.json` `dependencies` uses.
  The registry's dependency grammar (and the client's
  `parseDepSpecifier`) accepts scoped ids as well as slugs. The
  dependency is also what makes the `services` requirement satisfiable
  on a fresh install: the installer resolves the closure, counts the
  visualizer entry's declared `provides` in its plan-stage availability
  estimate, and re-verifies the downloaded package's manifest
  `contributes.services` before activating anything.

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
