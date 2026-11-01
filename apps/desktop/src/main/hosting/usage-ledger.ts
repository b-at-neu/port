// usage-ledger.json's only writer: 31 days of cumulative per-handle spend, keyed by boot id, for Settings → Usage & storage.
// A missing or malformed file loads empty, so a lost ledger shows no totals rather than a wrong one.
import type { FileResult } from '@/types/platform'
import type { HostedSessionSnapshot } from '@/types/hosting'
import type { UsageLedger, UsageRecord, UsageRow, UsageSummary } from '@/types/settings'
import { aggregateUsage } from '@/utils/hosting/usage'
import type { UsageTotals } from '@/utils/hosting/usage'
import type { RepoId } from '@/utils/repos'

const CURRENT_VERSION = 1
const LEDGER_RETENTION_DAYS = 31
const WEEK_DAYS = 7
const MONTH_DAYS = 30

interface LedgerFileShape {
  readonly version: number
  readonly records: readonly unknown[]
}

interface CreateUsageLedgerParams {
  readonly path: string
  readonly readJson: <T>(path: string) => Promise<FileResult<T>>
  readonly writeJsonAtomic: (path: string, value: unknown) => Promise<FileResult<void>>
  readonly now: () => Date
  readonly bootId: string
}

function isRecord(value: unknown): value is UsageRecord {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return (
    typeof r.id === 'string' &&
    r.id !== '' &&
    (r.repoId === null || typeof r.repoId === 'string') &&
    typeof r.lastAt === 'string' &&
    !Number.isNaN(Date.parse(r.lastAt)) &&
    (r.costUsd === null || typeof r.costUsd === 'number') &&
    (r.tokens === null || typeof r.tokens === 'number')
  )
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function daysBefore(day: Date, days: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() - days)
}

function retained(records: Iterable<UsageRecord>, now: Date): UsageRecord[] {
  const cutoff = now.getTime() - LEDGER_RETENTION_DAYS * 24 * 60 * 60 * 1000
  return [...records].filter((record) => Date.parse(record.lastAt) >= cutoff)
}

function totalsOf(records: readonly UsageRecord[]): UsageTotals {
  let costUsd: number | null = null
  let totalTokens: number | null = null
  for (const record of records) {
    if (record.costUsd !== null) costUsd = (costUsd ?? 0) + record.costUsd
    if (record.tokens !== null) totalTokens = (totalTokens ?? 0) + record.tokens
  }
  return { costUsd, totalTokens, sessions: records.length }
}

/** Local calendar days: `today` since local midnight, `week` the last 7 days including today, `month` the last 30. All-null readings stay `null`, never `0`. */
export function summarizeUsage(records: readonly UsageRecord[], now: Date): UsageSummary {
  const today = startOfLocalDay(now)
  const weekStart = daysBefore(today, WEEK_DAYS - 1).getTime()
  const monthStart = daysBefore(today, MONTH_DAYS - 1).getTime()
  const inWindow = records.filter((record) => Date.parse(record.lastAt) >= monthStart)

  const byRepo = new Map<RepoId | null, UsageRecord[]>()
  for (const record of inWindow) byRepo.set(record.repoId, [...(byRepo.get(record.repoId) ?? []), record])

  const rows: UsageRow[] = [...byRepo.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
    .map(([repoId, group]) => ({
      repoId,
      today: totalsOf(group.filter((record) => Date.parse(record.lastAt) >= today.getTime())),
      week: totalsOf(group.filter((record) => Date.parse(record.lastAt) >= weekStart)),
      month: totalsOf(group),
    }))

  const oldest = inWindow.map((record) => record.lastAt).sort()[0]
  return { rows, since: oldest ?? null }
}

export function createUsageLedger(params: CreateUsageLedgerParams): UsageLedger {
  let records = new Map<string, UsageRecord>()
  let writing = false
  let loading = false
  let deferred = false
  let pending: string | null = null
  let lastWritten: string | null = null
  let readFailed = false

  function flush(): void {
    if (loading) {
      deferred = true
      return
    }
    if (readFailed) return
    const document = { version: CURRENT_VERSION, records: retained(records.values(), params.now()) }
    const json = JSON.stringify(document)
    if (json === lastWritten) return
    if (writing) {
      pending = json
      return
    }
    writing = true
    void params.writeJsonAtomic(params.path, document).then((result) => {
      if (result.ok) lastWritten = json
      else console.error(`[hosting] could not write ${params.path}: ${result.message}`)
      writing = false
      if (pending !== null) {
        pending = null
        flush()
      }
    })
  }

  async function readFile(): Promise<void> {
    const result = await params.readJson<LedgerFileShape>(params.path)
    if (!result.ok) {
      if (result.kind !== 'not-found') {
        readFailed = true
        console.error(`[hosting] could not read ${params.path}: ${result.message} — leaving it untouched this launch`)
      }
      return
    }
    const value = result.value
    if (typeof value !== 'object' || value === null || typeof value.version !== 'number' || value.version > CURRENT_VERSION || !Array.isArray(value.records)) {
      console.error(`[hosting] ${params.path} is malformed or was written by a newer version of Port — starting empty`)
      return
    }
    const loaded = new Map<string, UsageRecord>()
    for (const record of retained(value.records.filter(isRecord), params.now())) loaded.set(record.id, record)
    // Anything observed before the load settled is newer than the file.
    for (const [id, record] of records) loaded.set(id, record)
    records = loaded
  }

  async function load(): Promise<void> {
    loading = true
    try {
      await readFile()
    } finally {
      loading = false
      if (deferred) {
        deferred = false
        flush()
      }
    }
  }

  function observe(snapshot: HostedSessionSnapshot): void {
    if (snapshot.usage === null) return
    const { costUsd, totalTokens } = aggregateUsage([snapshot.usage])
    const id = `${params.bootId}:${snapshot.sessionKey}`
    const existing = records.get(id)
    if (existing !== undefined && existing.costUsd === costUsd && existing.tokens === totalTokens) return
    records.set(id, { id, repoId: snapshot.repoId, lastAt: params.now().toISOString(), costUsd, tokens: totalTokens })
    flush()
  }

  return { load, observe, summary: () => summarizeUsage(retained(records.values(), params.now()), params.now()) }
}
