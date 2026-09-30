// appendAudit / readAuditLog over `<dir>/writes.jsonl` — one JSON object per
// line, `\n`-terminated. `dir` is `app.getPath('userData')`, injected by the
// composition root the same way `main/registry/store.ts`'s own directory
// parameter is, so this file imports no Electron. Rotates at 8 MB by
// renaming to `writes.prev.jsonl` before appending, so the reader can report
// "older entries exist and are not shown" rather than presenting a rotated
// file's remainder as the whole history. `appendTextFile` is called only
// here under `apps/desktop/src/` — one appender, so no second path can write
// an entry that skipped the chokepoint (`scripts/checks/desktop-writes.mjs`
// pins this).
import { appendTextFile, pathOps as defaultPathOps, readLinesFrom, renamePath, statPath } from '../platform'
import type { FileFailureKind, PathOps } from '../platform'
import type { AuditEntry, AuditRead, AuditReadFailureKind, ReadAuditLogParams } from '../../shared/writes/types'

const LOG_FILE = 'writes.jsonl'
const PREV_LOG_FILE = 'writes.prev.jsonl'
const ROTATE_AT_BYTES = 8 * 1024 * 1024
// Generous relative to the 8 MB rotation threshold — the read cap exists
// only to stop a runaway file from OOM-ing the main process, the same
// reasoning `files.ts`'s own `MAX_BYTES` documents for the denials log.
const MAX_READ_BYTES = 32 * 1024 * 1024

function logPath(dir: string, pathOps: PathOps): string {
  return pathOps.join(dir, LOG_FILE)
}

function prevLogPath(dir: string, pathOps: PathOps): string {
  return pathOps.join(dir, PREV_LOG_FILE)
}

export type AppendAuditResult = { readonly ok: true } | { readonly ok: false; readonly message: string }

/** Best-effort relative to the write it is recording: a failure here never
 *  changes the `WriteOutcome` `applyLabels`/`postComment` already computed,
 *  it only means that attempt's own audit line did not land. */
export async function appendAudit(dir: string, entry: AuditEntry, pathOps: PathOps = defaultPathOps): Promise<AppendAuditResult> {
  const path = logPath(dir, pathOps)

  const size = await statPath(path)
  if (size.ok && size.value.size > ROTATE_AT_BYTES) {
    const rotated = await renamePath(path, prevLogPath(dir, pathOps))
    if (!rotated.ok) return { ok: false, message: rotated.message }
  }

  const appended = await appendTextFile(path, `${JSON.stringify(entry)}\n`)
  if (!appended.ok) return { ok: false, message: appended.message }
  return { ok: true }
}

/** Collapses a platform-layer failure kind this reader cannot otherwise
 *  produce (`not-a-file`, reading a directory; `unparseable`, which
 *  `readLinesFrom`'s streaming reader never returns) into `io` — a narrowing
 *  map, not a 1:1 pin, since `AuditReadFailureKind` is deliberately smaller
 *  than `FileFailureKind`. */
function toAuditReadFailureKind(kind: FileFailureKind): AuditReadFailureKind {
  if (kind === 'permission-denied' || kind === 'too-large') return kind
  return 'io'
}

/** Filters by `repo`/`number` and caps at `limit` (newest first is the
 *  reader's presentation choice, not this function's — entries are returned
 *  oldest-first, matching the file's own append order). A malformed line is
 *  counted, never silently dropped. The size cap is now an explicit
 *  pre-check against `statPath` rather than a streamed abort — `readLinesFrom`
 *  reads one bounded window rather than the whole file, so an oversized log
 *  must be caught before the read, not during it. */
export async function readAuditLog(
  dir: string,
  params: ReadAuditLogParams = {},
  pathOps: PathOps = defaultPathOps,
  now: () => Date = () => new Date(),
): Promise<AuditRead> {
  const readAt = now().toISOString()
  const path = logPath(dir, pathOps)

  const prevStat = await statPath(prevLogPath(dir, pathOps))
  const previousPath = prevStat.ok ? prevLogPath(dir, pathOps) : null

  const size = await statPath(path)
  if (!size.ok) {
    if (size.kind === 'not-found') {
      return { ok: true, entries: [], malformed: 0, previousPath, readAt }
    }
    return { ok: false, kind: toAuditReadFailureKind(size.kind), message: size.message, readAt }
  }
  if (size.value.size > MAX_READ_BYTES) {
    return { ok: false, kind: 'too-large', message: `${path} exceeds the ${MAX_READ_BYTES}-byte cap`, readAt }
  }

  const result = await readLinesFrom(path, 0, { maxBytes: MAX_READ_BYTES })
  if (!result.ok) {
    if (result.kind === 'not-found') {
      return { ok: true, entries: [], malformed: 0, previousPath, readAt }
    }
    return { ok: false, kind: toAuditReadFailureKind(result.kind), message: result.message, readAt }
  }

  let malformed = 0
  const entries: AuditEntry[] = []
  for (const line of result.value.lines) {
    if (line.trim() === '') continue
    try {
      entries.push(JSON.parse(line) as AuditEntry)
    } catch {
      malformed++
    }
  }

  const filtered = entries.filter(
    (entry) => (params.repo === undefined || entry.repo === params.repo) && (params.number === undefined || entry.number === params.number),
  )
  const limited = params.limit !== undefined && filtered.length > params.limit ? filtered.slice(-params.limit) : filtered

  return { ok: true, entries: limited, malformed, previousPath, readAt }
}
