/**
 * Configuration shared by the headless half and the UI half of this plugin.
 *
 * Both entry bundles (`dist/index.js` and `dist/ui-desktop.js`) are built
 * from this source tree, so each bundle carries its own copy of this small
 * module — that is normal for one npm package with two entry points. What
 * the two halves must agree on lives here exactly once *in source*: the
 * config shape, the defaults, and the validation rules.
 *
 * How config flows at runtime (see README for the longer version):
 * - The desktop loader passes the registry entry's config to the headless
 *   def's `apply(ctx, config)`; the headless half resolves it against
 *   {@link DEFAULT_METERS_CONFIG} with {@link resolveMetersConfig}.
 * - The composed UI def is registered without a config argument, so the UI
 *   half keeps its own session state seeded from the same defaults. Runtime
 *   changes made in the views are session-local: persisting per-plugin
 *   settings would need a host storage capability (`db:own`), which this
 *   example deliberately does not request (see `capabilities` in
 *   `BBeBee.plugin.json`).
 */

export type MetersMode = 'spectrum' | 'spectrogram' | 'vu'

export type MetersPaletteName = 'ember' | 'ice' | 'mono'

export interface MetersConfig {
  /** Which meter the view shows first (and the settings card's default). */
  mode: MetersMode
  /** Pseudocolor palette for spectrum / spectrogram / VU rendering. */
  palette: MetersPaletteName
}

export const METERS_MODES: readonly MetersMode[] = ['spectrum', 'spectrogram', 'vu']

export const METERS_PALETTES: readonly MetersPaletteName[] = ['ember', 'ice', 'mono']

export const DEFAULT_METERS_CONFIG: MetersConfig = {
  mode: 'spectrum',
  palette: 'ember',
}

/**
 * The declared config schema for this plugin, in JSON-Schema shape.
 *
 * The headless half exports this so hosts and tooling can introspect what
 * the plugin accepts in its registry-entry config. Keep it in sync with
 * {@link MetersConfig} — {@link resolveMetersConfig} is the runtime half of
 * the same contract.
 */
export const METERS_CONFIG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: {
      type: 'string',
      enum: [...METERS_MODES],
      default: DEFAULT_METERS_CONFIG.mode,
      description: 'Meter shown by default: spectrum bars, spectrogram waterfall, or VU meter.',
    },
    palette: {
      type: 'string',
      enum: [...METERS_PALETTES],
      default: DEFAULT_METERS_CONFIG.palette,
      description: 'Pseudocolor palette used to render levels.',
    },
  },
} as const

/**
 * Resolves untrusted input (loader config, JSON, …) into a valid
 * {@link MetersConfig}: unknown fields are dropped, invalid values fall
 * back per-field to the defaults, non-objects yield the defaults outright.
 * Pure — unit-tested in `test/meters-math.test.ts`.
 */
export function resolveMetersConfig(input: unknown): MetersConfig {
  if (input === null || typeof input !== 'object') {
    return { ...DEFAULT_METERS_CONFIG }
  }
  const raw = input as Record<string, unknown>
  return {
    mode: isMode(raw.mode) ? raw.mode : DEFAULT_METERS_CONFIG.mode,
    palette: isPalette(raw.palette) ? raw.palette : DEFAULT_METERS_CONFIG.palette,
  }
}

function isMode(value: unknown): value is MetersMode {
  return typeof value === 'string' && (METERS_MODES as readonly string[]).includes(value)
}

function isPalette(value: unknown): value is MetersPaletteName {
  return typeof value === 'string' && (METERS_PALETTES as readonly string[]).includes(value)
}
