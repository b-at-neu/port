import type { FixtureScenario } from '../../src/types/fixtures'

// The visual harness's route → capture table (#317) — exhaustive by type
// over its own `ROUTE_KEYS`, so a route added to the router fails `pnpm
// typecheck` here until it is classified. `ROUTE_KEYS` is a hand-maintained
// copy of `router/routes.ts`'s own `ROUTE_IDS` keys, never an import of it —
// `tsconfig.node.json`'s own project (`composite: true`) cannot admit a file
// outside its `include` list, and `router/routes.ts` belongs to the
// renderer's web project, not this one. `scripts/checks/desktop-visual.ts`
// pins the two key sets against each other, both directions.
export const ROUTE_KEYS = ['board', 'repos', 'repo', 'settingsRepo', 'history', 'search', 'transcript', 'session', 'settings', 'backlog', 'releases', 'audit', 'needsYou', 'setup', 'about'] as const

// Resolved against `process.cwd()` at the point of use (`screens.spec.mts`),
// never here — this stays the bare, pinned literal `scripts/checks/
// desktop-visual.ts` and `docs/DESIGN.md` §7 both check against. A packaged
// run writes to its own directory so it never collides with a local
// `pnpm screenshots` run's output.
export const SCREENSHOT_DIR = process.env['PORT_VISUAL_PACKAGED'] === '1' ? 'out/screenshots-packaged' : 'out/screenshots'

export const THEMES = ['light', 'dark'] as const
export type Theme = (typeof THEMES)[number]

// A named sub-state of a capture target, with its own ready selector and
// an optional click/type (and hash) to reach it.
export interface CaptureVariant {
  readonly name: string
  readonly hash?: string
  readonly click?: string
  readonly type?: { readonly selector: string; readonly text: string }
  readonly ready: string
}

export interface Target {
  /** The route's own hash, set via `location.hash` before waiting for
   *  `ready`. */
  readonly hash: string
  /** The element `settle` waits to be visible, with no `[data-slot="skeleton"]`
   *  left inside it, before a screenshot is taken. */
  readonly container: string
  /** A selector that only exists once the screen has actually loaded — never
   *  the container itself, which exists the instant the route mounts. */
  readonly ready: string
  /** Extra states of this same screen, each written to its own
   *  `${key}-${variant}-${theme}.png` (`screens.spec.mts`). */
  readonly variants?: readonly CaptureVariant[]
}

// Extra captures run under a non-default fixture scenario, alongside
// `SCREENSHOT_TARGETS`'s own populated-scenario set.
export interface VariantTarget {
  readonly name: string
  readonly scenario: NonDefaultScenario
  readonly target: Target
}

type NonDefaultScenario = Exclude<FixtureScenario, 'populated'>

// The hash each scenario's launch redirect settles on, or null when it never redirects. Exhaustive, so a new
// scenario fails typecheck until it is classified.
export const SCENARIO_LANDING: Readonly<Record<NonDefaultScenario, string | null>> = {
  empty: null,
  unregistered: '#/setup',
  failing: null,
  'registry-error': '#/setup',
}

// The permission dialog is app-wide — its one fixture session is served only
// under the `empty` scenario (see `main/fixtures/sessions.ts`'s own note on
// `fixturePermissionSnapshots`), so capturing it here never blocks any other
// target's own click or ready selector.
export const VARIANT_TARGETS: readonly VariantTarget[] = [
  { name: 'needs-you-empty', scenario: 'empty', target: { hash: '#/needs-you', container: '#app', ready: '[data-slot="needs-you-empty"]' } },
  { name: 'releases-empty', scenario: 'empty', target: { hash: '#/releases', container: '#app', ready: '[data-slot="releases-empty"]' } },
  { name: 'audit-empty', scenario: 'empty', target: { hash: '#/audit', container: '#app', ready: '[data-slot="audit-empty"]' } },
  { name: 'session-permission', scenario: 'empty', target: { hash: '#/session?key=fixture-session-permission', container: '#app', ready: '[role="alertdialog"]' } },
  { name: 'board-unregistered', scenario: 'unregistered', target: { hash: '#/board', container: '#app', ready: 'text=Add a repository to see its pipeline.' } },
  { name: 'backlog-unregistered', scenario: 'unregistered', target: { hash: '#/backlog', container: '#app', ready: 'text=Register a repository to see its open tickets.' } },
  { name: 'repos-unregistered', scenario: 'unregistered', target: { hash: '#/settings?section=repositories', container: '#app', ready: 'text=Add a port-managed repository to see its pipeline.' } },
  { name: 'history-empty', scenario: 'unregistered', target: { hash: '#/history', container: '#app', ready: '[data-slot="history-empty"]' } },
  { name: 'board-error', scenario: 'failing', target: { hash: '#/board', container: '#app', ready: "text=Couldn't reach GitHub" } },
  { name: 'backlog-error', scenario: 'failing', target: { hash: '#/backlog', container: '#app', ready: "text=GitHub's rate limit is used up." } },
  { name: 'history-error', scenario: 'failing', target: { hash: '#/history', container: '#app', ready: "text=Couldn't read your Claude projects directory" } },
  { name: 'repos-error', scenario: 'registry-error', target: { hash: '#/settings?section=repositories', container: '#app', ready: "text=isn't valid JSON" } },
]

const FIXTURE_SESSION_ID = 'fixture-session-streaming'

/** One target per `ROUTE_KEYS` entry — the `Readonly<Record<…>>` annotation
 *  is what makes this exhaustive: a key added to `ROUTE_KEYS` (and, via the
 *  pin above, to the real `ROUTE_IDS`) and left out here fails `pnpm
 *  typecheck` in this file, never silently falling through to "not
 *  captured". */
export const SCREENSHOT_TARGETS: Readonly<Record<(typeof ROUTE_KEYS)[number], Target>> = {
  board: {
    hash: '#/board',
    container: '#app',
    ready: '[data-slot="ticket-row"]',
    variants: [
      { name: 'detail', hash: '#/board?item=fixture-acme-widgets:38', ready: '[role="complementary"]' },
      { name: 'detail-sessions', hash: '#/board?item=fixture-acme-widgets:46', ready: '[role="complementary"]' },
      { name: 'gate-review', click: 'text=Review plan', ready: '[data-slot="dialog-content"]' },
      { name: 'repo-empty', hash: '#/board?repo=fixture-acme-gadgets', ready: "text=Nothing in this repository's pipeline." },
    ],
  },
  repos: { hash: '#/repositories', container: '#app', ready: '[data-slot="repo-row"]' },
  // `repo` is a redirect into `settingsRepo`; this capture proves an old link still lands.
  repo: { hash: '#/repositories/fixture-acme-widgets', container: '#app', ready: '[role="tablist"]' },
  settingsRepo: {
    hash: '#/settings/repositories/fixture-acme-widgets',
    container: '#app',
    ready: '[role="tablist"]',
    variants: [
      { name: 'worktrees', hash: '#/settings/repositories/fixture-acme-widgets?tab=worktrees', ready: '[data-slot="worktree-row"]' },
      { name: 'worktrees-reclaim', hash: '#/settings/repositories/fixture-acme-widgets?tab=worktrees', click: 'text=Reclaim 1', ready: '[data-slot="alert-dialog-content"]' },
      { name: 'denials', hash: '#/settings/repositories/fixture-acme-widgets?tab=denials', ready: '[data-slot="denial-shape-row"]' },
      { name: 'denials-actor', hash: '#/settings/repositories/fixture-acme-widgets?tab=denials&denialsGroup=actor', ready: '[data-slot="denial-actor-row"]' },
      { name: 'denials-empty', hash: '#/settings/repositories/fixture-acme-gadgets?tab=denials', ready: 'text=No denial log yet' },
      { name: 'problem', hash: '#/settings/repositories/fixture-acme-legacy-site', ready: '[role="alert"]' },
      { name: 'mis-resolved', hash: '#/settings/repositories/fixture-acme-gadgets', ready: '[data-slot="label-verdict"]' },
    ],
  },
  history: {
    hash: '#/history',
    container: '#app',
    ready: '[data-slot="history-group-pinned"]',
    variants: [{ name: 'archived', hash: '#/history?archived=true', ready: '[data-slot="history-group-archived"]' }],
  },
  search: {
    hash: '#/search',
    container: '#app',
    ready: 'text=port reads transcripts',
    variants: [{ name: 'results', type: { selector: 'input[placeholder^="An error"]', text: 'widgets' }, ready: 'mark' }],
  },
  transcript: { hash: `#/transcript/${FIXTURE_SESSION_ID}`, container: '#app', ready: '[data-slot="tool-call-row"]' },
  // `session:list` carries three fixture snapshots (streaming, ended,
  // starting) — the base target shows the empty state, a variant per other
  // snapshot's own `?key=`. The pending-permission state is its own
  // `VARIANT_TARGETS` entry below, in the `empty` scenario's isolated launch.
  session: {
    hash: '#/session',
    container: '#app',
    ready: '[data-slot="session-empty"]',
    variants: [
      { name: 'streaming', hash: `#/session?key=${FIXTURE_SESSION_ID}`, ready: '[data-slot="tool-call-row"]' },
      { name: 'stage', hash: '#/session?key=fixture-stage-impl-38', ready: 'aside [aria-current="page"]' },
      { name: 'ended', hash: '#/session?key=fixture-session-ended', ready: 'text=Crashed' },
      { name: 'starting', hash: '#/session?key=fixture-session-starting', ready: 'text=Starting' },
      { name: 'question', hash: '#/session?key=fixture-session-question', ready: '[data-slot="question-card"]' },
      { name: 'plan', hash: '#/session?key=fixture-session-plan', ready: '[data-slot="plan-card"]' },
      { name: 'new-session', click: '[data-slot="session-empty"] button', ready: '[data-slot="new-session-dialog"]' },
      { name: 'changes', hash: `#/session?key=${FIXTURE_SESSION_ID}&pane=changes`, ready: 'text=Changes since' },
      { name: 'menu', hash: `#/session?key=${FIXTURE_SESSION_ID}`, click: '[aria-label="Session menu"]', ready: '[data-slot="usage-totals"]' },
      { name: 'sidebar-menu', click: 'aside [data-slot="session-row-menu"]', ready: '[role="menu"]' },
    ],
  },
  settings: {
    hash: '#/settings',
    container: '#app',
    ready: '[data-slot="settings-shortcuts"]',
    variants: [
      { name: 'repositories', hash: '#/settings?section=repositories', ready: '[data-slot="repo-row"]' },
      { name: 'connections', hash: '#/settings?section=connections', ready: '[data-slot="connection-row"]' },
      { name: 'pipeline', hash: '#/settings?section=pipeline', ready: '[data-slot="settings-repo-config"]' },
      { name: 'usage', hash: '#/settings?section=usage', ready: '[data-slot="usage-row"]' },
      { name: 'about', hash: '#/settings?section=about', ready: '[data-about-notice]' },
      { name: 'status-popover', click: '[data-slot="status-dot"]', ready: '[data-slot="status-popover"]' },
    ],
  },
  backlog: { hash: '#/backlog', container: '#app', ready: '[data-slot="backlog-row"]' },
  releases: { hash: '#/releases', container: '#app', ready: '[data-slot="release-row"]' },
  audit: {
    hash: '#/audit',
    container: '#app',
    ready: '[data-slot="audit-row"]',
    variants: [{ name: 'filtered', hash: '#/audit?repo=fixture-acme-widgets&number=38', ready: '[data-slot="audit-row"]' }],
  },
  needsYou: {
    hash: '#/needs-you',
    container: '#app',
    ready: '[data-slot="needs-you-item"]',
    variants: [
      { name: 'held', ready: 'text=its branch conflicts with the base branch' },
      { name: 'stalled', ready: 'text=its agent stopped responding' },
    ],
  },
  setup: { hash: '#/setup', container: '#app', ready: '#app [data-step]' },
  about: { hash: '#/about', container: '#app', ready: '#app [data-about-notice]' },
}
