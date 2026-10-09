// `main/tick/` itself stays read-only; this module is a separate sibling the watcher calls
// *after* `planTick` returns, never a write reachable from inside the tick computation.
import { appendTextFile, ensureDirectory, renamePath, statPath } from '../platform/files'
import { defaultGitRunner, resolveGitBaseRoot } from '../platform/git'
import { pathOps as defaultPathOps } from '../platform/paths'
import type { GitRunner } from '../platform/git'
import type { PathOps } from '../platform/paths'
import type { TickReport } from '../../shared/tick/types'
import type { DesktopTickEvent } from './types'

export type { GitRunner }

const LOG_FILE = 'desktop-events.jsonl'
const PREV_LOG_FILE = 'desktop-events.prev.jsonl'
const ROTATE_AT_BYTES = 8 * 1024 * 1024

export interface RecordTickDeps {
  readonly git?: GitRunner
  readonly pathOps?: PathOps
}

/** `repo` is the `owner/name` slug — `report.repoId` alone is not joinable against the cockpit's
 *  own record. */
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

// Best-effort and out-of-band: a disk-full or permission error must never fail a poll, so every
// failure here is swallowed rather than surfaced to the caller.
export async function recordTick(repoRoot: string, event: DesktopTickEvent, deps: RecordTickDeps = {}): Promise<void> {
  try {
    const pathOps = deps.pathOps ?? defaultPathOps
    const git = deps.git ?? defaultGitRunner()
    const baseRoot = await resolveGitBaseRoot(git, repoRoot, pathOps)
    const path = pathOps.join(baseRoot, '.agents', LOG_FILE)
    const prevPath = pathOps.join(baseRoot, '.agents', PREV_LOG_FILE)

    // `.agents/` may not exist yet in a fresh checkout.
    await ensureDirectory(pathOps.dirname(path))

    const size = await statPath(path)
    if (size.ok && size.value.size > ROTATE_AT_BYTES) {
      await renamePath(path, prevPath)
    }

    await appendTextFile(path, `${JSON.stringify(event)}\n`)
  } catch {
    // Deliberately swallowed — a write failure here must never block a poll.
  }
}
