// The canned items behind `board.ts`'s fixture snapshot, one seed per row the screens need to show.
import type { LabelKey } from '@/utils/labels/vocabulary'
import type { BlockerRead } from '@/types/github'
import type { FixtureScenario } from '@/types/fixtures'

export const VIEWER = 'octo-dev'

interface StageMove {
  readonly key: LabelKey
  readonly actor: string
  readonly offsetMinutes: number
}

export interface ItemSeed {
  readonly kind: 'issue' | 'pull-request'
  readonly number: number
  readonly title: string
  readonly stageKey: LabelKey
  // Defaults to empty — a pull request's closing keyword is what links it to its issue.
  readonly body?: string
  // Defaults to [VIEWER] — only the unowned-held seed overrides it.
  readonly assignees?: readonly string[]
  // Defaults to a single move onto stageKey — the pagination item below walks a realistic multi-stage path instead.
  readonly history?: readonly StageMove[]
  // Minutes-ago offset for updatedAt — defaults to the last history entry's own offset.
  readonly updatedMinutesAgo?: number
  // A pull request's mergeability — defaults to 'MERGEABLE'; ignored for issues.
  readonly mergeable?: 'MERGEABLE' | 'CONFLICTING'
  // A pull request's comments — defaults to none; ignored for issues.
  readonly comments?: readonly { readonly body: string; readonly offsetMinutes: number }[]
  // An issue's open blocked-by links — defaults to none; ignored for pull requests.
  readonly blockers?: BlockerRead
  // A blocked issue's newest comments — defaults to none selected; ignored for pull requests.
  readonly blockerComments?: readonly { readonly body: string; readonly offsetMinutes: number }[]
}

const CURRENCY_ESCALATION = [
  '## Pipeline Escalation',
  '3 conflicts — 1 resolved automatically, 2 need a decision',
  '',
  '### Auto-resolved (reapplied on the next attempt)',
  '- `pnpm-lock.yaml` — regenerated from the base',
  '',
  '### D1 — `src/money.ts`',
  '**Ours:** rounds half-up in `roundCents`',
  '**Theirs:** rounds half-even in `roundCents`',
  '',
  '| Option | Keeps | Loses |',
  '| --- | --- | --- |',
  '| **A take ours** | half-up rounding | the base branch\'s half-even change |',
  '| **B take theirs** | half-even rounding | this PR\'s half-up change |',
  '| **C keep both** | both behaviours behind a flag | a single code path |',
  '',
  '**Recommendation: B** — the base already ships half-even to callers.',
  '',
  '### D2 — `src/format.ts`',
  '**Ours:** formats totals with two decimals',
  '**Theirs:** formats totals with the locale default',
  '',
  '| Option | Keeps | Loses |',
  '| --- | --- | --- |',
  '| **A take ours** | fixed two decimals | locale-aware formatting |',
  '| **B take theirs** | locale-aware formatting | fixed two decimals |',
  '| **C keep both rounding modes** | a `mode` argument on `formatTotal` | the one-argument signature |',
  '',
  '**Recommendation: C** — callers on both sides still need their own mode.',
].join('\n')

const TAX_REGION_BLOCKERS: BlockerRead = {
  ok: true,
  open: [
    { number: 49, title: 'Add tax region to the customer record', url: 'https://github.com/acme/widgets/issues/49', state: 'OPEN' },
    { number: 48, title: 'Store invoice line tax', url: 'https://github.com/acme/widgets/issues/48', state: 'OPEN' },
  ],
  shown: 2,
  total: 2,
}

/** One item per stage family the board groups by, so the screenshot shows every group non-empty, plus two seeds for the Needs you screen's own label-kinds. */
const POPULATED_ITEM_SEEDS: readonly ItemSeed[] = [
  { kind: 'issue', number: 41, title: 'Add CSV export to the reports page', stageKey: 'planReview' },
  {
    kind: 'issue',
    number: 38,
    title: 'Retry failed webhook deliveries',
    stageKey: 'inProgress',
    // A multi-phase walk, so R6's phase list has every finished line plus a live current one to render.
    history: [
      { key: 'planning', actor: 'port-bot', offsetMinutes: -45 },
      { key: 'planReview', actor: 'port-bot', offsetMinutes: -40 },
      { key: 'planApproved', actor: VIEWER, offsetMinutes: -35 },
      { key: 'inProgress', actor: 'port-bot', offsetMinutes: -2 },
    ],
  },
  { kind: 'issue', number: 44, title: 'Show the build number in the footer', stageKey: 'ready' },
  {
    kind: 'pull-request',
    number: 36,
    title: 'Paginate the audit log',
    stageKey: 'approved',
    // A realistic multi-stage walk, so R7/R8 have a non-trivial phase history to render.
    history: [
      { key: 'ready', actor: 'octo-dev', offsetMinutes: -180 },
      { key: 'planning', actor: 'port-bot', offsetMinutes: -170 },
      { key: 'planReview', actor: 'port-bot', offsetMinutes: -150 },
      { key: 'planApproved', actor: 'octo-dev', offsetMinutes: -140 },
      { key: 'inProgress', actor: 'port-bot', offsetMinutes: -130 },
      { key: 'prOpened', actor: 'port-bot', offsetMinutes: -60 },
      { key: 'approved', actor: 'octo-dev', offsetMinutes: -10 },
    ],
  },
  { kind: 'pull-request', number: 35, title: 'Cache avatar thumbnails', stageKey: 'needsRevision' },
  // An issue and the pull request that closes it, so the Board folds them into one row; the unlabelled-body pull request above stays the one with no ticket.
  {
    kind: 'issue',
    number: 46,
    title: 'Show the last sync time in the header',
    stageKey: 'prOpened',
    history: [
      { key: 'planning', actor: 'port-bot', offsetMinutes: -170 },
      { key: 'planReview', actor: 'port-bot', offsetMinutes: -160 },
      { key: 'planApproved', actor: VIEWER, offsetMinutes: -150 },
      { key: 'inProgress', actor: 'port-bot', offsetMinutes: -140 },
      { key: 'prOpened', actor: 'port-bot', offsetMinutes: -90 },
    ],
  },
  {
    kind: 'pull-request',
    number: 47,
    title: 'Show the last sync time in the header',
    stageKey: 'reviewing',
    body: 'Closes #46',
    history: [
      { key: 'readyForReview', actor: 'port-bot', offsetMinutes: -90 },
      { key: 'reviewing', actor: 'port-bot', offsetMinutes: -80 },
      { key: 'needsRevision', actor: 'port-bot', offsetMinutes: -60 },
      { key: 'revising', actor: 'port-bot', offsetMinutes: -50 },
      { key: 'readyForReview', actor: 'port-bot', offsetMinutes: -30 },
      { key: 'reviewing', actor: 'port-bot', offsetMinutes: -10 },
    ],
  },
  // A rebase escalation with two decisions, so the Needs you screen's Unblock dialog has picks to show.
  { kind: 'pull-request', number: 37, title: 'Normalize currency rounding', stageKey: 'needsHuman', comments: [{ body: CURRENCY_ESCALATION, offsetMinutes: -8 }] },
  { kind: 'issue', number: 50, title: 'Rotate the webhook signing secret', stageKey: 'needsHuman' },
  { kind: 'issue', number: 51, title: 'Backfill order totals for Q3', stageKey: 'blocked' },
  // Blocked on two open dependency tickets, so the Board's tag reads "Waiting on #49 +1".
  { kind: 'issue', number: 55, title: 'Split invoices by tax region', stageKey: 'blocked', blockers: TAX_REGION_BLOCKERS },
  // Blocked with no session, so the reason comes from the ticket's own comment, written just before the label.
  {
    kind: 'issue',
    number: 56,
    title: 'Archive closed workspaces',
    stageKey: 'blocked',
    blockerComments: [{ body: "## Blocker\nThe retention period isn't in the plan. Decide 30 or 90 days.", offsetMinutes: -11 }],
  },
  // Unassigned and queued, so planTick's ownership partition holds it with reason 'unowned' — the Board's "Waiting on you" row needs one.
  { kind: 'issue', number: 52, title: 'Add a dark-mode icon for the tray', stageKey: 'ready', assignees: [] },
  // Conflicting against the base branch, so planTick's mergeability gate surfaces it as a Needs-you 'held' item.
  { kind: 'pull-request', number: 53, title: 'Upgrade the PDF renderer', stageKey: 'readyForReview', mergeable: 'CONFLICTING', updatedMinutesAgo: -5 },
  // No attached agent, so the dispatch ledger's unmatched read reaches the Needs-you 'stalled' classification.
  { kind: 'issue', number: 54, title: 'Migrate session storage to Redis', stageKey: 'inProgress', updatedMinutesAgo: -40 },
]

// Keeps only the routine, non-"needs you" seeds, so the Needs you screen renders its empty state while the Board stays non-empty.
const EMPTY_ITEM_SEEDS: readonly ItemSeed[] = [
  { kind: 'issue', number: 38, title: 'Retry failed webhook deliveries', stageKey: 'inProgress' },
  { kind: 'issue', number: 44, title: 'Show the build number in the footer', stageKey: 'ready' },
  { kind: 'pull-request', number: 35, title: 'Cache avatar thumbnails', stageKey: 'needsRevision' },
]

export function itemSeedsFor(scenario: FixtureScenario): readonly ItemSeed[] {
  return scenario === 'empty' ? EMPTY_ITEM_SEEDS : POPULATED_ITEM_SEEDS
}
