// Pure: records → one counted group per signature, and the export document.
import { INCIDENT_GROUP_ITEMS_LIMIT, type IncidentExportDocument, type IncidentGroup, type IncidentItemRef, type IncidentPruned, type IncidentRecord } from '@/types/incidents'

function stageAndCondition(record: IncidentRecord): { readonly stage: string; readonly condition: string } {
  const rest = record.signature.slice(record.bucket.length + 1)
  const split = rest.indexOf(':')
  return split === -1 ? { stage: rest, condition: '' } : { stage: rest.slice(0, split), condition: rest.slice(split + 1) }
}

export function groupIncidents(records: readonly IncidentRecord[]): readonly IncidentGroup[] {
  const groups = new Map<string, { group: IncidentGroup; items: Map<string, IncidentItemRef>; count: number; firstAt: string; lastAt: string }>()
  for (const record of records) {
    const item: IncidentItemRef = { repo: record.repo, kind: record.kind, number: record.number }
    const itemKey = `${record.repo}#${String(record.number)}`
    const held = groups.get(record.signature)
    if (held === undefined) {
      const { stage, condition } = stageAndCondition(record)
      const group: IncidentGroup = { signature: record.signature, bucket: record.bucket, stage, condition, count: 0, firstAt: record.at, lastAt: record.at, items: [], droppedItems: 0 }
      groups.set(record.signature, { group, items: new Map([[itemKey, item]]), count: 1, firstAt: record.at, lastAt: record.at })
      continue
    }
    held.items.set(itemKey, item)
    held.count += 1
    if (record.at < held.firstAt) held.firstAt = record.at
    if (record.at > held.lastAt) held.lastAt = record.at
  }
  return [...groups.values()]
    .map(({ group, items, count, firstAt, lastAt }): IncidentGroup => {
      const all = [...items.values()]
      return { ...group, count, firstAt, lastAt, items: all.slice(0, INCIDENT_GROUP_ITEMS_LIMIT), droppedItems: Math.max(0, all.length - INCIDENT_GROUP_ITEMS_LIMIT) }
    })
    .sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0))
}

export function exportDocument(groups: readonly IncidentGroup[], read: { readonly malformed: number; readonly pruned: IncidentPruned | null }, repo: string | null, now: Date): IncidentExportDocument {
  return { v: 1, exportedAt: now.toISOString(), repo, groups, malformed: read.malformed, pruned: read.pruned }
}
