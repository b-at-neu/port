// Append-only `incidents.jsonl`: one serialized writer per process, best-effort, never read for a decision.
import { appendTextFile, readJsonFile, readLinesFrom, renamePath, statPath, writeJsonFileAtomic, writeTextFile } from '@/main/platform/files'
import { pathOps as defaultPathOps } from '@/main/platform/paths'
import { boundInputs } from '@/main/incidents/snapshot'
import { signatureOf } from '@/main/incidents/raise'
import type { FileFailureKind, PathOps } from '@/types/platform'
import type { IncidentDraft, IncidentFiles, IncidentLog, IncidentPruned, IncidentRead, IncidentReadFailureKind, IncidentRecord } from '@/types/incidents'

const LOG_FILE = 'incidents.jsonl'
const TEMP_FILE = 'incidents.tmp'
const PRUNED_FILE = 'incidents.pruned.json'
const DAY_MS = 24 * 60 * 60 * 1000

export const INCIDENT_LIMITS = {
  maxBytes: 32 * 1024 * 1024,
  pruneToBytes: 24 * 1024 * 1024,
  maxAgeMs: 90 * DAY_MS,
  readCapBytes: 40 * 1024 * 1024,
} as const

const defaultFiles: IncidentFiles = { append: appendTextFile, readJson: readJsonFile, readLines: readLinesFrom, rename: renamePath, stat: statPath, writeJson: writeJsonFileAtomic, writeText: writeTextFile }

export interface IncidentLogDeps {
  readonly dir: string
  readonly now: () => Date
  readonly newId: () => string
  readonly files?: IncidentFiles
  readonly pathOps?: PathOps
  readonly limits?: typeof INCIDENT_LIMITS
}

interface ParsedLine {
  readonly text: string
  readonly at: string | null
}

function parseLine(text: string): ParsedLine {
  try {
    const value = JSON.parse(text) as { at?: unknown }
    return { text, at: typeof value.at === 'string' ? value.at : null }
  } catch {
    return { text, at: null }
  }
}

function toReadFailureKind(kind: FileFailureKind): IncidentReadFailureKind {
  return kind === 'permission-denied' || kind === 'too-large' ? kind : 'io'
}

export function createIncidentLog(deps: IncidentLogDeps): IncidentLog {
  const files = deps.files ?? defaultFiles
  const pathOps = deps.pathOps ?? defaultPathOps
  const limits = deps.limits ?? INCIDENT_LIMITS
  const path = pathOps.join(deps.dir, LOG_FILE)
  const tempPath = pathOps.join(deps.dir, TEMP_FILE)
  const prunedPath = pathOps.join(deps.dir, PRUNED_FILE)
  let chain: Promise<void> = Promise.resolve()
  let ageCheckedAt: number | null = null

  async function readPruned(): Promise<IncidentPruned | null> {
    const stored = await files.readJson<IncidentPruned>(prunedPath)
    return stored.ok && typeof stored.value.count === 'number' && typeof stored.value.through === 'string' ? stored.value : null
  }

  async function prune(): Promise<void> {
    const lines = await files.readLines(path, 0, { maxBytes: limits.readCapBytes })
    if (!lines.ok) return
    const parsed = lines.value.lines.filter((line) => line.trim() !== '').map(parseLine)
    const cutoff = new Date(deps.now().getTime() - limits.maxAgeMs).toISOString()
    let kept = parsed.filter((line) => line.at !== null && line.at >= cutoff)
    let size = kept.reduce((total, line) => total + Buffer.byteLength(line.text) + 1, 0)
    while (size > limits.pruneToBytes && kept.length > 0) {
      const [oldest, ...rest] = kept
      if (oldest === undefined) break
      size -= Buffer.byteLength(oldest.text) + 1
      kept = rest
    }
    const keptSet = new Set(kept)
    const dropped = parsed.filter((line) => !keptSet.has(line))
    if (dropped.length === 0) return
    const before = await readPruned()
    const through = dropped.reduce((newest, line) => (line.at !== null && line.at > newest ? line.at : newest), before?.through ?? '')
    const sidecar = await files.writeJson(prunedPath, { count: (before?.count ?? 0) + dropped.length, through: through === '' ? deps.now().toISOString() : through })
    if (!sidecar.ok) return
    const written = await files.writeText(tempPath, kept.map((line) => `${line.text}\n`).join(''))
    if (!written.ok) return
    await files.rename(tempPath, path)
  }

  async function prunedIfDue(): Promise<void> {
    const size = await files.stat(path)
    if (!size.ok) return
    const nowMs = deps.now().getTime()
    const ageDue = ageCheckedAt === null || nowMs - ageCheckedAt >= DAY_MS
    if (size.value.size <= limits.maxBytes && !ageDue) return
    if (ageDue) ageCheckedAt = nowMs
    if (size.value.size <= limits.maxBytes) {
      const head = await files.readLines(path, 0, { maxBytes: limits.readCapBytes })
      const [first] = head.ok ? head.value.lines : []
      const oldest = first === undefined ? null : parseLine(first).at
      if (oldest === null || oldest >= new Date(nowMs - limits.maxAgeMs).toISOString()) return
    }
    await prune()
  }

  async function append(draft: IncidentDraft): Promise<void> {
    await prunedIfDue()
    const entry: IncidentRecord = {
      v: 1,
      id: deps.newId(),
      at: deps.now().toISOString(),
      repo: draft.repo,
      number: draft.number,
      kind: draft.kind,
      bucket: draft.bucket,
      signature: signatureOf(draft.bucket, draft.stage, draft.condition),
      decision: draft.decision,
      inputs: boundInputs(draft.inputs),
      outcome: draft.outcome,
      related: draft.related,
      resolvedBy: null,
    }
    await files.append(path, `${JSON.stringify(entry)}\n`)
  }

  function record(draft: IncidentDraft): Promise<void> {
    chain = chain.then(() => append(draft)).catch(() => undefined)
    return chain
  }

  async function read(): Promise<IncidentRead> {
    const readAt = deps.now().toISOString()
    const pruned = await readPruned()
    const size = await files.stat(path)
    if (!size.ok) return size.kind === 'not-found' ? { ok: true, records: [], malformed: 0, pruned, readAt } : { ok: false, kind: toReadFailureKind(size.kind), message: size.message, readAt }
    if (size.value.size > limits.readCapBytes) return { ok: false, kind: 'too-large', message: `${path} exceeds the ${String(limits.readCapBytes)}-byte cap`, readAt }
    const lines = await files.readLines(path, 0, { maxBytes: limits.readCapBytes })
    if (!lines.ok) return lines.kind === 'not-found' ? { ok: true, records: [], malformed: 0, pruned, readAt } : { ok: false, kind: toReadFailureKind(lines.kind), message: lines.message, readAt }
    const records: IncidentRecord[] = []
    let malformed = 0
    for (const line of lines.value.lines) {
      if (line.trim() === '') continue
      try {
        records.push(JSON.parse(line) as IncidentRecord)
      } catch {
        malformed++
      }
    }
    return { ok: true, records, malformed, pruned, readAt }
  }

  return { record, read }
}
