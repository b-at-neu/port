import type { BacklogChild, BacklogEpicGroup, BacklogEpicLayout, BacklogEpicSummary, BacklogRowView, BacklogWave } from '@/types/backlog'

interface Placement {
  readonly layerOf: ReadonlyMap<number, number>
  readonly cycles: readonly number[]
}

function isEpic(row: BacklogRowView): boolean {
  return row.children.ok ? row.children.total > 0 : row.subIssueCount > 0
}

function isUncertain(child: BacklogChild): boolean {
  return !child.blockers.ok || child.blockers.shown < child.blockers.total
}

function memberEdges(child: BacklogChild, members: ReadonlySet<number>): number[] {
  if (!child.blockers.ok) return []
  return child.blockers.open.map((blocker) => blocker.number).filter((number) => members.has(number))
}

// Tarjan emits a component only after every component it depends on, so layers resolve in emission order.
function placeMembers(members: readonly BacklogChild[]): Placement {
  const memberSet = new Set(members.map((child) => child.number))
  const edges = new Map(members.map((child) => [child.number, memberEdges(child, memberSet)]))
  const index = new Map<number, number>()
  const low = new Map<number, number>()
  const onStack = new Set<number>()
  const stack: number[] = []
  const components: number[][] = []

  const visit = (node: number): void => {
    index.set(node, index.size)
    low.set(node, index.get(node) ?? 0)
    stack.push(node)
    onStack.add(node)
    for (const next of edges.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next)
        low.set(node, Math.min(low.get(node) ?? 0, low.get(next) ?? 0))
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node) ?? 0, index.get(next) ?? 0))
      }
    }
    if (low.get(node) !== index.get(node)) return
    const component: number[] = []
    let top: number | undefined
    do {
      top = stack.pop()
      if (top === undefined) break
      onStack.delete(top)
      component.push(top)
    } while (top !== node)
    components.push(component)
  }

  for (const child of members) if (!index.has(child.number)) visit(child.number)

  const layerOf = new Map<number, number>()
  const cycles: number[] = []
  for (const component of components) {
    const inComponent = new Set(component)
    const cyclic = component.length > 1 || (edges.get(component[0] ?? 0) ?? []).includes(component[0] ?? 0)
    if (cyclic) cycles.push(...component)
    let layer = 1
    for (const node of component) {
      for (const next of edges.get(node) ?? []) {
        if (!inComponent.has(next)) layer = Math.max(layer, (layerOf.get(next) ?? 0) + 1)
      }
    }
    for (const node of component) layerOf.set(node, layer)
  }
  return { layerOf, cycles: cycles.sort((a, b) => a - b) }
}

function buildEpic(
  epic: BacklogRowView,
  rows: readonly BacklogRowView[],
  placed: Set<number>,
  isShown: (row: BacklogRowView) => boolean,
): BacklogEpicGroup | null {
  const read = epic.children
  const byNumber = new Map(rows.map((row) => [row.number, row]))
  const named = (row: BacklogRowView): boolean => row.parent.ok && row.parent.parent?.number === epic.number

  if (!read.ok) {
    const unplaced = rows.filter((row) => named(row) && !isEpic(row) && !placed.has(row.number))
    for (const row of unplaced) placed.add(row.number)
    const visible = unplaced.filter(isShown)
    if (!isShown(epic) && visible.length === 0) return null
    return { epic, waves: [], unplaced: visible, summary: { ok: false, reason: read.reason } }
  }

  const closed = new Set(read.children.filter((child) => child.state === 'CLOSED').map((child) => child.number))
  const members = read.children.filter((child) => child.state === 'OPEN')
  const { layerOf, cycles } = placeMembers(members)
  const uncertain = members.filter(isUncertain).map((child) => child.number).sort((a, b) => a - b)

  const waves: BacklogWave[] = []
  const lastLayer = Math.max(0, ...layerOf.values())
  for (let number = 1; number <= lastLayer; number++) {
    const inWave = members.filter((child) => layerOf.get(child.number) === number)
    const claimed = inWave.filter((child) => child.claimed).length
    const waveNumbers = new Set(inWave.filter((child) => !child.claimed).map((child) => child.number))
    const waveRows = rows.filter((row) => {
      if (!waveNumbers.has(row.number) || isEpic(row) || placed.has(row.number)) return false
      return isShown(row)
    })
    const unlisted = waveNumbers.size - waveRows.length
    waves.push({ number, rows: waveRows, inProgress: claimed, unlisted, inProgressOnly: waveRows.length === 0 && unlisted === 0 && claimed > 0 })
  }

  for (const child of read.children) {
    const row = byNumber.get(child.number)
    if (row && !isEpic(row)) placed.add(row.number)
  }
  const unplaced = rows.filter((row) => named(row) && !isEpic(row) && !placed.has(row.number))
  for (const row of unplaced) placed.add(row.number)
  const visibleUnplaced = unplaced.filter(isShown)

  if (!isShown(epic) && visibleUnplaced.length === 0 && waves.every((wave) => wave.rows.length === 0)) return null

  const cycleSet = new Set(cycles)
  const uncertainSet = new Set(uncertain)
  const canStart = members.filter(
    (child) =>
      !child.claimed &&
      !uncertainSet.has(child.number) &&
      !cycleSet.has(child.number) &&
      child.blockers.ok &&
      child.blockers.open.every((blocker) => closed.has(blocker.number)),
  )
  const summary: BacklogEpicSummary = {
    ok: true,
    done: closed.size,
    inProgress: members.filter((child) => child.claimed).length,
    open: members.filter((child) => !child.claimed).length,
    total: read.total,
    canStart,
    truncated: read.shown < read.total ? { shown: read.shown, total: read.total } : null,
    uncertain,
    cycles,
  }
  return { epic, waves, unplaced: visibleUnplaced, summary }
}

export function buildEpicLayout(rows: readonly BacklogRowView[], shown?: ReadonlySet<number>): BacklogEpicLayout {
  const isShown = (row: BacklogRowView): boolean => shown === undefined || shown.has(row.number)
  const placed = new Set<number>()
  const epics: BacklogEpicGroup[] = []
  for (const row of rows) {
    if (!isEpic(row)) continue
    const group = buildEpic(row, rows, placed, isShown)
    if (group) epics.push(group)
  }
  const remainder = rows.filter((row) => !isEpic(row) && !placed.has(row.number) && isShown(row))
  return { epics, remainder }
}
