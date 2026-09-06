// The real-repository-log case for `shared/local/inspect.ts` (#85) lives
// here, not in `shared/local/inspect.test.ts`: `readDenials` is a
// `main/local/` export, and `shared/local/inspect.test.ts` must import
// nothing from `src/main/` — the same purity the inspector itself rests on
// (Decision 2) — since `tsconfig.web.json` type-checks every file under
// `src/shared/**/*` including its transitive imports, and a platform-layer
// import there would pull Node-only module resolution into a project whose
// file list never listed those files (`tsc`'s `TS6307`).
import { describe, expect, it } from 'vitest'
import { inspectDenials } from '../../shared/local/inspect'
import { readDenials } from './denials'

const realRead = await readDenials({ repoRoot: process.cwd() })
const hasRealLog = realRead.ok && realRead.present

describe.skipIf(!hasRealLog)('inspectDenials — this repository real log', () => {
  it('holds its structural invariants against the real .agents/denials.log', () => {
    const result = inspectDenials({ read: realRead, sessions: null })
    if (!result.ok || !result.present) throw new Error('expected present')

    expect(result.analysed).toBeLessThanOrEqual(result.summary.total)
    expect(result.capped).toBe(result.analysed < result.summary.total)

    const tally = result.attribution
    expect(tally.agentAttributed + tally.sessionAttributed + tally.sessionUnresolved + tally.attributionUnavailable + tally.unattributable).toBe(result.analysed)

    expect(result.summary.misses).toBeGreaterThan(0)
    // No miss is ever folded into an agent-attributed count — every group's
    // own `miss` bucket sums back to the top-level total, never into `deny`.
    const missAcrossActors = result.byActor.reduce((sum, group) => sum + group.counts.miss, 0)
    expect(missAcrossActors).toBe(result.summary.misses)
  })
})
