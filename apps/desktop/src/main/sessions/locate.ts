// A git worktree's project directory carries a hash suffix no mangling of its `cwd` can derive, so the directory is resolved by listing, never mangled.
import { listDirectory } from '../platform/files'
import { pathOps } from '../platform/paths'
import type { SessionFailureKind } from '../../shared/sessions/types'

/** Shared core so the bare-id validator and the filename matcher never drift apart. */
const SESSION_ID_CORE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

/** Shared with `transcript.ts`'s request validation — a session id is always a UUID. */
export const SESSION_ID_RE = new RegExp(`^${SESSION_ID_CORE}$`, 'i')

const SESSION_ID_FILENAME = new RegExp(`^(${SESSION_ID_CORE})\\.jsonl$`, 'i')

export type ProjectIndex = ReadonlyMap<string, string>

export type BuildProjectIndexResult =
  | { readonly ok: true; readonly index: ProjectIndex; readonly scannedProjects: number }
  | { readonly ok: false; readonly kind: SessionFailureKind; readonly message: string }

/** An individual project directory that fails to list is skipped rather than failing the whole index. */
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

/** `undefined` means nothing resolved, which the caller must report in `unresolved`, never silently as zero agents. */
export function resolveSessionDir(sessionId: string, index: ProjectIndex): string | undefined {
  const projectDir = index.get(sessionId)
  if (projectDir === undefined) return undefined
  return pathOps.join(projectDir, sessionId)
}

/** The one place `CLAUDE_CONFIG_DIR` is read. */
export function defaultClaudeHome(): string {
  const fromEnv = process.env['CLAUDE_CONFIG_DIR']
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return pathOps.expandHome('~/.claude')
}

export type ResolveTranscriptPathResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly kind: 'session-unresolved' | 'invalid-id' }

/** Never a path the caller hands in. Asserts the result stays under the session's own directory, never the wider projects root, since a traversal-shaped `agentId` could otherwise reach a sibling project. */
export function resolveTranscriptPath(sessionId: string, agentId: string | null, index: ProjectIndex): ResolveTranscriptPathResult {
  const projectDir = index.get(sessionId)
  if (projectDir === undefined) return { ok: false, kind: 'session-unresolved' }

  // A session's own transcript sits flat in projectDir; only a subagent's transcript nests under subagents/.
  const sessionDir = pathOps.join(projectDir, sessionId)
  const candidate = agentId === null ? pathOps.join(projectDir, `${sessionId}.jsonl`) : pathOps.join(sessionDir, 'subagents', `agent-${agentId}.jsonl`)

  if (agentId !== null && !pathOps.contains(sessionDir, candidate)) {
    return { ok: false, kind: 'invalid-id' }
  }
  return { ok: true, path: candidate }
}
