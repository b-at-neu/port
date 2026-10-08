// The visual harness's route → capture/skip table (#317) — exhaustive by
// type over its own `ROUTE_KEYS`, so a route added to the router fails
// `pnpm typecheck` here until it is classified one way or the other.
// `ROUTE_KEYS` is a hand-maintained copy of `router/legacy-view.ts`'s own
// `ROUTE_IDS` keys, never an import of it — `tsconfig.node.json`'s own
// project (`composite: true`) cannot admit a file outside its `include`
// list, and `router/legacy-view.ts` belongs to the renderer's web project,
// not this one. `scripts/checks/desktop-visual.ts` pins the two key sets
// against each other, both directions.
export const ROUTE_KEYS = ['board', 'repos', 'repo', 'sessions', 'search', 'transcript', 'session', 'settings', 'backlog', 'needsYou', 'setup', 'about'] as const

// Resolved against `process.cwd()` at the point of use (`screens.spec.mts`),
// never here — this stays the bare, pinned literal `scripts/checks/
// desktop-visual.ts` and `docs/DESIGN.md` §7 both check against.
export const SCREENSHOT_DIR = 'out/screenshots'

export const THEMES = ['light', 'dark'] as const
export type Theme = (typeof THEMES)[number]

interface CaptureTarget {
  readonly kind: 'capture'
  /** The route's own hash, set via `location.hash` before waiting for
   *  `ready`. */
  readonly hash: string
  /** The element `settle` waits to be visible, with no `[data-slot="skeleton"]`
   *  left inside it, before a screenshot is taken. */
  readonly container: string
  /** A selector that only exists once the screen has actually loaded — never
   *  the container itself, which exists the instant the route mounts. */
  readonly ready: string
}

interface SkipTarget {
  readonly kind: 'skip'
  readonly hash: string
  /** Shown in the test's own skip message, and asserted against if
   *  `#react-root` ever becomes visible for this route (see
   *  `screens.spec.mts`). */
  readonly reason: string
}

export type Target = CaptureTarget | SkipTarget

// Extra captures run under a non-default fixture scenario, alongside
// `SCREENSHOT_TARGETS`'s own populated-scenario set.
export interface VariantTarget {
  readonly name: string
  readonly scenario: 'empty'
  readonly target: CaptureTarget
}

export const VARIANT_TARGETS: readonly VariantTarget[] = [
  { name: 'needs-you-empty', scenario: 'empty', target: { kind: 'capture', hash: '#/needs-you', container: '#react-root', ready: '[data-slot="needs-you-empty"]' } },
]

const LEGACY_SCREEN_REASON = 'Legacy screen, reachable only through in-app clicks; a deep link shows an unloaded shell. Becomes a capture target when #320 migrates it.'

/** One target per `ROUTE_KEYS` entry — the `Readonly<Record<…>>` annotation
 *  is what makes this exhaustive: a key added to `ROUTE_KEYS` (and, via the
 *  pin above, to the real `ROUTE_IDS`) and left out here fails `pnpm
 *  typecheck` in this file, never silently falling through to "not
 *  captured". */
export const SCREENSHOT_TARGETS: Readonly<Record<(typeof ROUTE_KEYS)[number], Target>> = {
  board: { kind: 'capture', hash: '#/board', container: '#react-root', ready: '[data-slot="ticket-row"]' },
  repos: { kind: 'capture', hash: '#/repositories', container: '#react-root', ready: '[data-slot="repo-row"]' },
  repo: { kind: 'capture', hash: '#/repositories/fixture-acme-widgets', container: '#react-root', ready: '[role="tablist"]' },
  // No hosted session exists in fixture mode (`session:list` is always
  // `[]`), so the screen's own empty state is what actually renders —
  // `.session-view__empty`, never the composer, which `session/view.ts`
  // keeps hidden until a session is selected.
  session: { kind: 'capture', hash: '#/session', container: '#session-view', ready: '.session-view__empty' },
  settings: { kind: 'capture', hash: '#/settings', container: '#react-root', ready: '#react-root h2' },
  backlog: { kind: 'capture', hash: '#/backlog', container: '#react-root', ready: '[data-slot="backlog-row"]' },
  needsYou: { kind: 'capture', hash: '#/needs-you', container: '#react-root', ready: '[data-slot="needs-you-item"]' },
  setup: { kind: 'capture', hash: '#/setup', container: '#react-root', ready: '#react-root [data-step]' },
  about: { kind: 'capture', hash: '#/about', container: '#react-root', ready: '#react-root [data-about-notice]' },
  sessions: { kind: 'skip', hash: '#/repositories/fixture-acme-widgets/sessions', reason: LEGACY_SCREEN_REASON },
  search: { kind: 'skip', hash: '#/repositories/fixture-acme-widgets/search', reason: LEGACY_SCREEN_REASON },
  transcript: { kind: 'skip', hash: '#/transcript/fixture-session', reason: LEGACY_SCREEN_REASON },
}
