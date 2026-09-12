// The session-directory ladder (#78, Decision 2). A git worktree is its own
// project directory under `<claudeHome>/projects/`, carrying a hash suffix
// no mangling of its `cwd` can derive — verified on this machine:
// `-home-benedikt-Documents-Projects-aplio--claude-worktrees-issue-396-1d2d9e`
// is nothing a dashed rewrite of that `cwd` would produce. So the directory
// is resolved, never mangled: list `<claudeHome>/projects/` once and every
// project directory once, collecting `sessionId → projectDir` from each
// `<uuid>.jsonl` filename — a session's own subdirectory is never the
// source, since it does not exist for a session that spawned no subagents.
import { listDirectory, pathOps } from '../platform'
import type { SessionFailureKind } from '../../shared/sessions/types'

/** The unanchored UUID shape shared by the two regexes below, so the bare-id
 *  validator (`SESSION_ID_RE`) and the filename matcher can never drift
 *  apart — each applies its own anchors around this same core. */
const SESSION_ID_CORE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

/** The bare id shape, shared with `transcript.ts`'s request validation so
 *  the two never drift apart — a session id is always a UUID. */
export const SESSION_ID_RE = new RegExp(`^${SESSION_ID_CORE}$`, 'i')

const SESSION_ID_FILENAME = new RegExp(`^(${SESSION_ID_CORE})\\.jsonl$`, 'i')

export type ProjectIndex = ReadonlyMap<string, string>

export type BuildProjectIndexResult =
  | { readonly ok: true; readonly index: ProjectIndex; readonly scannedProjects: number }
  | { readonly ok: false; readonly kind: SessionFailureKind; readonly message: string }

/** Lists `<claudeHome>/projects/` and every project directory beneath it
 *  exactly once. A `projects/` directory that does not exist is
 *  `claude-home-missing`; any other listing failure at that top level is
 *  `projects-unreadable`. An individual project directory that fails to
 *  list (permissions, a race) is skipped rather than failing the whole
 *  index — one bad project directory should not blind every other. */
export async function buildProjectIndex(claudeHome: string): Promise<BuildProjectIndexResult> {
  const projectsDir = pathOps.join(claudeHome, 'projects')
  const top = await listDirectory(projectsDir)
  if (!top.ok) {
    if (top.kind === 'not-found') {
      return { ok: false, kind: 'claude-home-missing', message: `${projectsDir} does not exist` }
    }
    return { ok: false, kind: 'projects-unreadable', message: top.message }
  }

  const index = new Map<string, string>()
  let scannedProjects = 0
  for (const entry of top.value) {
    if (entry.kind !== 'directory') continue
    const projectDir = pathOps.join(projectsDir, entry.name)
    const listing = await listDirectory(projectDir)
    scannedProjects += 1
    if (!listing.ok) continue
    for (const child of listing.value) {
      const match = SESSION_ID_FILENAME.exec(child.name)
      const sessionId = match?.[1]
      if (sessionId !== undefined && !index.has(sessionId)) {
        index.set(sessionId, projectDir)
      }
    }
  }
  return { ok: true, index, scannedProjects }
}

/** Decision 2's ladder: the transcript path the SDK reports, if `RawSession`
 *  ever carries one at a future SDK version — it does not, as of the
 *  currently pinned `SDKSessionInfo` (verified: no path field on it) — else
 *  the index built above. Never derives a directory name from `cwd` itself.
 *  `undefined` means the ladder found nothing, which the caller must report
 *  in `unresolved`, never silently as zero agents. */
export function resolveSessionDir(sessionId: string, index: ProjectIndex): string | undefined {
  const projectDir = index.get(sessionId)
  if (projectDir === undefined) return undefined
  return pathOps.join(projectDir, sessionId)
}

/** The one place `CLAUDE_CONFIG_DIR` is read — moved out of `adapter.ts` so
 *  the rule has a single copy rather than two (#83). */
export function defaultClaudeHome(): string {
  const fromEnv = process.env['CLAUDE_CONFIG_DIR']
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return pathOps.expandHome('~/.claude')
}

export type ResolveTranscriptPathResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly kind: 'session-unresolved' | 'invalid-id' }

/** Builds a transcript path from the project index only — never a path the
 *  caller hands in — for a session (`<projectDir>/<sessionId>.jsonl`) or a
 *  subagent (`<projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl`),
 *  then asserts the result still sits under that session's own directory.
 *  The IPC layer's id-pattern check is the real gate; this `contains`
 *  assertion is what proves the gate held. The boundary is deliberately the
 *  session's own directory, never the wider `<claudeHome>/projects` root —
 *  a traversal-shaped `agentId` that reached this far (defense in depth,
 *  not the expected path) can climb into a *sibling* project directory
 *  without ever leaving `projects/`, which a looser check would wrongly
 *  call safe. */
export function resolveTranscriptPath(sessionId: string, agentId: string | null, index: ProjectIndex): ResolveTranscriptPathResult {
  const projectDir = index.get(sessionId)
  if (projectDir === undefined) return { ok: false, kind: 'session-unresolved' }

  // A session's own transcript sits flat in projectDir (sibling of the
  // sessionId-named directory, per the real layout buildProjectIndex's own
  // listing reads); only a subagent's transcript nests inside that
  // directory's subagents/.
  const sessionDir = pathOps.join(projectDir, sessionId)
  const candidate = agentId === null ? pathOps.join(projectDir, `${sessionId}.jsonl`) : pathOps.join(sessionDir, 'subagents', `agent-${agentId}.jsonl`)

  if (agentId !== null && !pathOps.contains(sessionDir, candidate)) {
    return { ok: false, kind: 'invalid-id' }
  }
  return { ok: true, path: candidate }
}
