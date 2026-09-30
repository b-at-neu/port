// The search orchestrator (#87): scope -> index skip -> budgeted scan ->
// warm-on-read. Indexing is not a separate pass -- it is the side effect of
// scanning: a transcript with no fresh signature is a candidate, read
// through `openTranscript` (the barrel, never a deep `../sessions/*`
// import), matched, and its signature rebuilt from the same entries.
import { statPath } from '../platform'
import { buildProjectIndex, defaultClaudeHome, openTranscript, resolveTranscriptPath } from '../sessions'
import type { ProjectIndex } from '../sessions'
import type { AgentRecord, SessionRecord, SessionScan } from '../../shared/sessions/types'
import { agentLabel, sessionLabel } from '../../shared/sessions/label'
import { MAX_HITS_PER_TRANSCRIPT, MAX_TOTAL_HITS, SCAN_BUDGET_MS } from '../../shared/search/types'
import type { RepoId } from '../../shared/repos'
import type { SearchGroup, SearchHit, SearchResult, SearchScope } from '../../shared/search/types'
import type { TranscriptEntry } from '../../shared/sessions/transcript'
import { parseQuery } from './terms'
import { buildSignature, decodeSignature, encodeSignature, mightContain } from './signature'
import { hitsFor, searchableFields } from './match'
import { readSignatureIndex, writeSignatureIndex } from './store'
import type { SignatureIndexEntry } from './store'

export interface RunSearchParams {
  readonly scan: SessionScan
  /** Where `search-index.json` lives -- main passes `app.getPath('userData')`,
   *  the same directory `main/registry/store.ts`'s `registry.json` sits in. */
  readonly indexDir: string
  readonly query: string
  readonly scope: SearchScope
  readonly claudeHome?: string
  readonly now?: () => Date
}

interface Candidate {
  readonly sessionId: string
  readonly agentId: string | null
  readonly repoId: RepoId | null
  readonly label: string
  readonly itemNumber: number | null
  readonly idleMs: number
}

function keyFor(candidate: Pick<Candidate, 'sessionId' | 'agentId'>): string {
  return candidate.agentId === null ? candidate.sessionId : `${candidate.sessionId}#${candidate.agentId}`
}

function fromSession(session: SessionRecord): Candidate {
  return { sessionId: session.sessionId, agentId: null, repoId: session.repoId, label: sessionLabel(session), itemNumber: session.itemNumber, idleMs: session.idleMs }
}

function fromAgent(agent: AgentRecord): Candidate {
  return { sessionId: agent.sessionId, agentId: agent.agentId, repoId: agent.repoId, label: agentLabel(agent), itemNumber: agent.itemNumber, idleMs: agent.idleMs }
}

/** `repo` filters on `repoId`; `all` includes every session and agent,
 *  including the `repoId: null` ones no registered repository claims --
 *  those are only ever reachable under `all` (Scope, in the plan). Sorted
 *  newest-activity-first (`idleMs` ascending) so a budget cutoff loses the
 *  coldest transcripts first. */
function candidatesFor(scan: Extract<SessionScan, { ok: true }>, scope: SearchScope): readonly Candidate[] {
  const inScope = (repoId: RepoId | null): boolean => scope.kind === 'all' || repoId === scope.repoId
  const candidates = [...scan.sessions.filter((s) => inScope(s.repoId)).map(fromSession), ...scan.agents.filter((a) => inScope(a.repoId)).map(fromAgent)]
  return candidates.slice().sort((a, b) => a.idleMs - b.idleMs)
}

function allSearchableText(entries: readonly TranscriptEntry[]): string {
  return entries.flatMap((entry) => searchableFields(entry).map((field) => field.text)).join('\n')
}

function groupFor(candidate: Candidate, hits: readonly SearchHit[]): SearchGroup {
  return { sessionId: candidate.sessionId, agentId: candidate.agentId, repoId: candidate.repoId, label: candidate.label, itemNumber: candidate.itemNumber, idleMs: candidate.idleMs, hitCount: hits.length, hits }
}

export async function runSearch(params: RunSearchParams): Promise<SearchResult> {
  const now = params.now ?? (() => new Date())
  const start = now().getTime()
  const { scan } = params

  const parsed = parseQuery(params.query)
  if (parsed.terms.length === 0) return { ok: false, kind: 'invalid-query' }

  if (!scan.ok) return { ok: false, kind: 'sessions-unavailable', sessionsKind: scan.kind, message: scan.message }

  const claudeHome = params.claudeHome ?? defaultClaudeHome()
  const candidates = candidatesFor(scan, params.scope)
  const inScope = candidates.length

  const indexResult = await buildProjectIndex(claudeHome)
  if (!indexResult.ok) return { ok: false, kind: 'sessions-unavailable', sessionsKind: indexResult.kind, message: indexResult.message }
  const projectIndex: ProjectIndex = indexResult.index

  const manifest = new Map<string, SignatureIndexEntry>(await readSignatureIndex(params.indexDir))

  const groups: SearchGroup[] = []
  let skippedByIndex = 0
  let read = 0
  let unreached = 0
  let totalHits = 0
  let hitsTruncated = false
  let budgetExhausted = false

  for (const candidate of candidates) {
    const key = keyFor(candidate)
    const resolved = resolveTranscriptPath(candidate.sessionId, candidate.agentId, projectIndex)
    if (!resolved.ok) {
      unreached += 1
      continue
    }

    const stat = await statPath(resolved.path)
    if (!stat.ok) {
      unreached += 1
      continue
    }

    const manifestEntry = manifest.get(key)
    const upToDate = manifestEntry !== undefined && manifestEntry.path === resolved.path && manifestEntry.sizeBytes === stat.value.size && manifestEntry.modifiedAt === stat.value.modifiedAt

    // Direction of failure: closed on the answer. The index may only ever
    // remove work it can *prove* unnecessary -- an absent or stale
    // signature is always a candidate, never a skip.
    if (upToDate) {
      const signature = decodeSignature(manifestEntry.bits, manifestEntry.signature)
      const provablyAbsent = parsed.terms.some((term) => !mightContain(signature, term))
      if (provablyAbsent) {
        skippedByIndex += 1
        continue
      }
    }

    // Both budgets gate *before* the open -- once either is exhausted, every
    // remaining candidate is unreached, never opened just to discard its
    // hits (that would spend the scan budget on results nobody sees).
    budgetExhausted ||= now().getTime() - start >= SCAN_BUDGET_MS
    const hitsBudgetExhausted = totalHits >= MAX_TOTAL_HITS
    if (budgetExhausted || hitsBudgetExhausted) {
      if (hitsBudgetExhausted) hitsTruncated = true
      unreached += 1
      continue
    }

    const opened = await openTranscript({ sessionId: candidate.sessionId, agentId: candidate.agentId, claudeHome, index: projectIndex })
    read += 1
    if (!opened.read.ok) continue

    const allHits = hitsFor(opened.read.entries, parsed.terms)
    const capped = allHits.length > MAX_HITS_PER_TRANSCRIPT ? allHits.slice(0, MAX_HITS_PER_TRANSCRIPT) : allHits
    if (allHits.length > capped.length) hitsTruncated = true

    // Warm on read regardless of whether this transcript matched -- a miss
    // still teaches the index what it does not contain.
    const signature = buildSignature(allSearchableText(opened.read.entries))
    manifest.set(key, { path: resolved.path, sizeBytes: stat.value.size, modifiedAt: stat.value.modifiedAt, bits: signature.bits, signature: encodeSignature(signature) })

    if (capped.length === 0) continue

    // `hitsBudgetExhausted` above guarantees `totalHits < MAX_TOTAL_HITS`
    // here, so `remaining` is always positive.
    const remaining = MAX_TOTAL_HITS - totalHits
    const included = capped.length > remaining ? capped.slice(0, remaining) : capped
    if (included.length < capped.length) hitsTruncated = true
    totalHits += included.length
    groups.push(groupFor(candidate, included))
  }

  const written = await writeSignatureIndex(params.indexDir, manifest)

  return {
    ok: true,
    groups,
    inScope,
    skippedByIndex,
    read,
    unreached,
    complete: unreached === 0,
    hitsTruncated,
    indexPersisted: written.ok,
    tookMs: now().getTime() - start,
  }
}
