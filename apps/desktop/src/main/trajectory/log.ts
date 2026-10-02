// recordTick: appends one DesktopTickEvent line to
// `<base repo root>/.agents/desktop-events.jsonl` (#111) — the app's own
// twin to `scripts/port-tick/events.ts`'s `appendEvent`, so a parity read
// (`scripts/port-tick/report.ts --desktop-events`) has something on the app
// side to diff the cockpit's own trajectory record against. `main/tick/`
// itself stays read-only per its own pinned rail (`desktop-tick`'s check
// 2) — this module is a separate sibling the watcher calls *after*
// `planTick` returns, never a write reachable from inside the tick
// computation. The base root is resolved the same
// `git rev-parse --git-common-dir` way `main/local/denials.ts` and
// `main/writes/claim.ts` already each carry their own copy of — a third
// copy, on the same precedent ("neither directory imports from the other
// and each is a single-purpose adapter").
import { appendTextFile, ensureDirectory, git as defaultGit, pathOps as defaultPathOps, renamePath, statPath } from '../platform'
import type { CommandResult, PathOps } from '../platform'
import type { TickReport } from '../../shared/tick/types'
import type { DesktopTickEvent } from './types'

const LOG_FILE = 'desktop-events.jsonl'
const PREV_LOG_FILE = 'desktop-events.prev.jsonl'
const ROTATE_AT_BYTES = 8 * 1024 * 1024

/** The same seam `main/local/denials.ts`/`main/writes/claim.ts` declare — a
 *  `git` invocation is needed here only to resolve the base repository root,
 *  never to read or write the trajectory record itself. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<CommandResult>

/** Identical in shape to `main/local/denials.ts`'s and `main/writes/claim.ts`'s
 *  own `resolveBaseRoot` — duplicated rather than shared, on the same
 *  precedent those two already establish. Degrades to `repoRoot` on any
 *  failure — the common case is a plain checkout where the two are
 *  identical. */
async function resolveBaseRoot(git: GitRunner, repoRoot: string, pathOps: PathOps): Promise<string> {
  const result = await git(['rev-parse', '--git-common-dir'], repoRoot)
  if (!result.ok) return repoRoot
  const common = result.stdout.trim()
  if (common === '') return repoRoot
  try {
    return pathOps.dirname(pathOps.resolveFrom(repoRoot, common))
  } catch {
    return repoRoot
  }
}

function defaultGitRunner(): GitRunner {
  return (args, cwd) => defaultGit(args, { cwd })
}

export interface RecordTickDeps {
  readonly git?: GitRunner
  readonly pathOps?: PathOps
}

/** Pure: one repository's `TickReport` (`main/tick/plan.ts`'s whole result)
 *  to the line `recordTick` appends. `repo` is the `owner/name` slug —
 *  `report.repoId` alone is not a fact `scripts/port-tick/parity.ts` can
 *  join a cockpit tick event on, since the cockpit's own record never
 *  carries this app's `RepoId`. */
export function buildDesktopTickEvent(params: { readonly repo: string; readonly report: TickReport; readonly now: () => Date }): DesktopTickEvent {
  const { repo, report, now } = params
  return {
    v: 1,
    ts: now().toISOString(),
    repo,
    repoId: report.repoId,
    dispatch: report.actionable.map((a) => ({ item: a.number, stage: `${a.agent}-agent`, agent: a.agent })),
    held: report.held.map((h) => ({ item: h.number, reason: h.reason, contention: h.contention, trigger: h.trigger })),
    claims: report.claims.map((c) => ({ item: c.number, class: c.class })),
    blind: report.blind,
  }
}

/** Best-effort and out-of-band, the same direction `scripts/port-tick/events.ts`'s
 *  own `appendEvent` already takes: a disk-full or permission error must
 *  never fail a poll, so every failure here is swallowed rather than
 *  surfaced to the caller (`main/state/watcher.ts`'s `buildSnapshot()` never
 *  awaits this call at all). Rotates to `desktop-events.prev.jsonl` at the
 *  same 8 MB cap `scripts/port-tick/events.ts` uses, so the two trajectory
 *  files age at the same rate. */
export async function recordTick(repoRoot: string, event: DesktopTickEvent, deps: RecordTickDeps = {}): Promise<void> {
  try {
    const pathOps = deps.pathOps ?? defaultPathOps
    const git = deps.git ?? defaultGitRunner()
    const baseRoot = await resolveBaseRoot(git, repoRoot, pathOps)
    const path = pathOps.join(baseRoot, '.agents', LOG_FILE)
    const prevPath = pathOps.join(baseRoot, '.agents', PREV_LOG_FILE)

    // `.agents/` may not exist yet in a fresh checkout — the same order
    // `main/writes/claim.ts`'s `takeClaimScope` follows before its own first
    // write under that directory.
    await ensureDirectory(pathOps.dirname(path))

    const size = await statPath(path)
    if (size.ok && size.value.size > ROTATE_AT_BYTES) {
      await renamePath(path, prevPath)
    }

    await appendTextFile(path, `${JSON.stringify(event)}\n`)
  } catch {
    // Deliberately swallowed — see header comment. A write failure here must
    // never change what buildSnapshot() returns or block a poll.
  }
}
