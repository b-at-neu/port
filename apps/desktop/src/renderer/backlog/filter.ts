// Pure label-filter logic for the Backlog — no DOM, no storage.
import type { BacklogLabel, BacklogLabelFilter, LabelOption } from '@/types/backlog'

export const EMPTY_FILTER: BacklogLabelFilter = { include: [], exclude: [] }

interface Labelled {
  readonly labels: readonly BacklogLabel[]
}

export function labelStateOf(filter: BacklogLabelFilter, name: string): LabelOption['state'] {
  if (filter.exclude.includes(name)) return 'hidden'
  if (filter.include.includes(name)) return 'only'
  return 'any'
}

// any → only → hidden → any; a name is never in both lists.
export function cycleLabel(filter: BacklogLabelFilter, name: string): BacklogLabelFilter {
  const include = filter.include.filter((entry) => entry !== name)
  const exclude = filter.exclude.filter((entry) => entry !== name)
  switch (labelStateOf(filter, name)) {
    case 'any':
      return { include: [...include, name], exclude }
    case 'only':
      return { include, exclude: [...exclude, name] }
    case 'hidden':
      return { include, exclude }
  }
}

export function applyLabelFilter<T extends Labelled>(items: readonly T[], filter: BacklogLabelFilter): readonly T[] {
  return items.filter((item) => {
    const names = item.labels.map((label) => label.name)
    if (names.some((name) => filter.exclude.includes(name))) return false
    return filter.include.length === 0 || names.some((name) => filter.include.includes(name))
  })
}

// Counts come from the unfiltered items, and a filtered name no item carries stays listed so it can be cleared.
export function labelOptionsOf(items: readonly Labelled[], filter: BacklogLabelFilter): readonly LabelOption[] {
  const byName = new Map<string, { label: BacklogLabel; count: number }>()
  for (const item of items) {
    for (const label of item.labels) {
      const seen = byName.get(label.name)
      if (seen === undefined) byName.set(label.name, { label, count: 1 })
      else seen.count += 1
    }
  }
  for (const name of [...filter.include, ...filter.exclude]) {
    if (!byName.has(name)) byName.set(name, { label: { name, color: null }, count: 0 })
  }
  return [...byName.values()]
    .sort((a, b) => a.label.name.localeCompare(b.label.name, undefined, { sensitivity: 'base' }))
    .map(({ label, count }) => ({ label, count, state: labelStateOf(filter, label.name) }))
}

export function activeCount(filter: BacklogLabelFilter): number {
  return filter.include.length + filter.exclude.length
}
