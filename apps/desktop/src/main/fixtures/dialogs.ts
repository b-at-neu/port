// Fixture mode's canned claim and plan-review preflights — the plan gate
// owned by this app so its dialog screenshots with every step reachable.
import type { GatePreflightResponse } from '../../shared/gate/types'
import type { ClaimPreflightResponse } from '../../shared/claim/types'
import type { OwnershipSummary } from '../../shared/writes/types'
import { LABEL_DEFAULTS } from '../../shared/labels/defaults'

const VIEWER = 'octo-dev'

function labelNameOf(key: 'marker' | 'planReview' | 'ready'): string {
  return LABEL_DEFAULTS.find((def) => def.key === key)?.name ?? key
}

const PLAN_MARKDOWN = `## Implementation Plan

## Overview
- Add a CSV export action to the reports page, reusing the existing report builder.

### Steps
1. Add an \`Export CSV\` button beside the existing \`Export PDF\` one.
2. Stream rows through a new \`csvEncode\` helper rather than building one string.

\`\`\`ts
function csvEncode(rows: readonly string[][]): string {
  return rows.map((row) => row.join(',')).join('\\n')
}
\`\`\`

| Column | Type |
| --- | --- |
| id | number |
| name | string |

See [the report spec](https://github.com/acme/widgets/issues/41) for the full column list.
`

function ownedByApp(now: Date): OwnershipSummary {
  return { kind: 'app', since: now.toISOString() }
}

export function fixtureGatePreflight(now: Date): GatePreflightResponse {
  return {
    kind: 'resolved',
    preflight: {
      number: 41,
      title: 'Add CSV export to the reports page',
      url: 'https://github.com/acme/widgets/issues/41',
      state: 'OPEN',
      labels: [labelNameOf('marker'), labelNameOf('planReview')],
      assignees: [VIEWER],
      viewer: VIEWER,
      ticketMarkdown: 'Operators keep asking for a CSV download beside the existing PDF export.',
      planMarkdown: PLAN_MARKDOWN,
      sessionRequired: false,
      sessionRequiredReason: null,
      autoPlan: false,
      readAt: now.toISOString(),
    },
    verdict: { kind: 'answerable', noPlanBlock: false, assignedElsewhere: [] },
    ownership: ownedByApp(now),
  }
}

export function fixtureClaimPreflight(now: Date): ClaimPreflightResponse {
  return {
    kind: 'resolved',
    preflight: {
      kind: 'issue',
      number: 44,
      title: 'Show the build number in the footer',
      url: 'https://github.com/acme/widgets/issues/44',
      state: 'OPEN',
      labels: [labelNameOf('ready')],
      assignees: [],
      viewer: VIEWER,
      blockers: { ok: true, open: [], shown: 0, total: 0 },
      readAt: now.toISOString(),
    },
    verdict: { kind: 'claimable', assigneeSituation: 'unassigned', others: [], closed: false, blockers: { ok: true, open: [], shown: 0, total: 0 } },
  }
}
