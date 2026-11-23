import type { BacklogChild, BacklogEpicBodyEntry, BacklogEpicGroup, BacklogEpicLayout, BacklogEpicSummary, BacklogLayoutEntry, BacklogRowView, BacklogWave } from '@/types/backlog'

interface Placement {
  readonly startOf: ReadonlyMap<number, number>
  readonly last: number
  readonly cycles: readonly number[]
}

interface BuildContext {
  readonly rows: readonly BacklogRowView[]
  readonly byNumber: ReadonlyMap<number, BacklogRowView>
  readonly placed: Set<number>
  readonly claimedEpics: Set<number>
  readonly isShown: (row: BacklogRowView) => boolean
  readonly spanOf: (number: number) => number
}

export function isEpic(row: BacklogRowView): boolean {
  return row.children.ok ? row.children.total > 0 : row.subIssueCount > 0
}

// Percentages of the bar; in progress is cumulative-rounded so the two never sum past 100.
export function epicProgressSegments(done: number, inProgress: number, total: number): { readonly done: number; readonly inProgress: number } {
  if (total === 0) return { done: 0, inProgress: 0 }
  const donePercent = Math.round((done / total) * 100)
  return { done: donePercent, inProgress: Math.round(((done + inProgress) / total) * 100) - donePercent }
}

function isUncertain(child: BacklogChild): boolean {
  return !child.blockers.ok || child.blockers.shown < child.blockers.total
}

function memberEdges(child: BacklogChild, members: ReadonlySet<number>): number[] {
  if (!child.blockers.ok) return []
  return [...child.blockers.open, ...child.blockers.closed].map((blocker) => blocker.number).filter((number) => members.has(number))
}

// Tarjan emits a component only after every component it depends on, so starts resolve in emission order.
function placeMembers(members: readonly BacklogChild[], spanOf: (number: number) => number): Placement {
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

  const startOf = new Map<number, number>()
  const cycles: number[] = []
  let last = 0
  for (const component of components) {
    const inComponent = new Set(component)
    const cyclic = component.length > 1 || (edges.get(component[0] ?? 0) ?? []).includes(component[0] ?? 0)
    if (cyclic) cycles.push(...component)
    let start = 1
    for (const node of component) {
      for (const next of edges.get(node) ?? []) {
        if (!inComponent.has(next)) start = Math.max(start, (startOf.get(next) ?? 0) + spanOf(next))
      }
    }
    for (const node of component) {
      startOf.set(node, start)
      last = Math.max(last, start + spanOf(node) - 1)
    }
  }
  return { startOf, last, cycles: cycles.sort((a, b) => a - b) }
}

function isNamedParent(row: BacklogRowView, epicNumber: number): boolean {
  return row.parent.ok && row.parent.parent?.number === epicNumber
}

function buildNested(starts: ReadonlyMap<number, number>, fallbackStart: number, epic: BacklogRowView, ctx: BuildContext): BacklogEpicGroup[] {
  const nested: BacklogEpicGroup[] = []
  const build = (row: BacklogRowView, start: number): void => {
    if (!isEpic(row) || ctx.claimedEpics.has(row.number)) return
    const group = buildEpic(row, start, ctx)
    if (group) nested.push(group)
  }
  if (epic.children.ok) {
    for (const child of epic.children.children) {
      const row = ctx.byNumber.get(child.number)
      if (row) build(row, starts.get(child.number) ?? fallbackStart)
    }
  }
  for (const row of ctx.rows) if (isNamedParent(row, epic.number)) build(row, fallbackStart)
  return nested.sort((a, b) => a.start - b.start || a.epic.number - b.epic.number)
}

function buildEpic(epic: BacklogRowView, start: number, ctx: BuildContext): BacklogEpicGroup | null {
  const { rows, byNumber, placed, isShown } = ctx
  const read = epic.children
  ctx.claimedEpics.add(epic.number)

  if (!read.ok) {
    const unplaced = rows.filter((row) => isNamedParent(row, epic.number) && !isEpic(row) && !placed.has(row.number))
    for (const row of unplaced) placed.add(row.number)
    const visible = unplaced.filter(isShown)
    const epics = buildNested(new Map(), start, epic, ctx)
    if (!isShown(epic) && visible.length === 0 && epics.length === 0) return null
    return { epic, start, waves: [], epics, unplaced: visible, summary: { ok: false, reason: read.reason } }
  }

  const closed = new Set(read.children.filter((child) => child.state === 'CLOSED').map((child) => child.number))
  const members = read.children.filter((child) => child.state === 'OPEN')
  // Starts come from the whole graph so a merge never renumbers later waves; waves with no listed row are hidden.
  const { startOf, last, cycles: allCycles } = placeMembers(read.children, ctx.spanOf)
  const openSet = new Set(members.map((child) => child.number))
  const cycles = allCycles.filter((number) => openSet.has(number))
  const uncertain = members.filter(isUncertain).map((child) => child.number).sort((a, b) => a - b)

  const waves: BacklogWave[] = []
  for (let relative = 1; relative <= last; relative++) {
    const waveNumbers = new Set(members.filter((child) => !child.claimed && startOf.get(child.number) === relative).map((child) => child.number))
    const waveRows = rows.filter((row) => waveNumbers.has(row.number) && !isEpic(row) && !placed.has(row.number) && isShown(row))
    if (waveRows.length > 0) waves.push({ number: start + relative - 1, rows: waveRows })
  }

  for (const child of read.children) {
    const row = byNumber.get(child.number)
    if (row && !isEpic(row)) placed.add(row.number)
  }
  const absoluteStarts = new Map([...startOf].map(([number, relative]) => [number, start + relative - 1]))
  const epics = buildNested(absoluteStarts, start + last, epic, ctx)
  const unplaced = rows.filter((row) => isNamedParent(row, epic.number) && !isEpic(row) && !placed.has(row.number))
  for (const row of unplaced) placed.add(row.number)
  const visibleUnplaced = unplaced.filter(isShown)

  if (!isShown(epic) && visibleUnplaced.length === 0 && waves.length === 0 && epics.length === 0) return null

  const cycleSet = new Set(cycles)
  const uncertainSet = new Set(uncertain)
  const canStart = members.filter((child) => {
    const row = byNumber.get(child.number)
    return (
      !child.claimed &&
      !(row && isEpic(row)) &&
      !uncertainSet.has(child.number) &&
      !cycleSet.has(child.number) &&
      child.blockers.ok &&
      child.blockers.open.every((blocker) => closed.has(blocker.number))
    )
  })
  const summary: BacklogEpicSummary = {
    ok: true,
    wavesMayShift: read.shown < read.total || read.children.some(isUncertain) || epics.some((nested) => nested.summary.ok && nested.summary.wavesMayShift),
    done: closed.size,
    inProgress: members.filter((child) => child.claimed).length,
    open: members.filter((child) => !child.claimed).length,
    total: read.total,
    canStart,
    truncated: read.shown < read.total ? { shown: read.shown, total: read.total } : null,
    uncertain,
    cycles,
  }
  return { epic, start, waves, epics, unplaced: visibleUnplaced, summary }
}

// Waves and nested epics in one ascending order; a wave comes first when it shares a number with a nested epic's start.
export function epicBodyEntries(group: BacklogEpicGroup): BacklogEpicBodyEntry[] {
  const entries: BacklogEpicBodyEntry[] = []
  const pending = [...group.epics]
  for (const wave of group.waves) {
    while (pending[0] !== undefined && pending[0].start < wave.number) {
      const nested = pending.shift()
      if (nested) entries.push({ kind: 'epic', group: nested })
    }
    entries.push({ kind: 'wave', wave })
  }
  for (const nested of pending) entries.push({ kind: 'epic', group: nested })
  return entries
}

// An unparsable or empty time sorts as oldest.
function createdMs(createdAt: string): number {
  const ms = Date.parse(createdAt)
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms
}

function entryCreatedAt(entry: BacklogLayoutEntry): string {
  return entry.kind === 'epic' ? entry.group.epic.createdAt : entry.row.createdAt
}

export function buildEpicLayout(rows: readonly BacklogRowView[], shown?: ReadonlySet<number>): BacklogEpicLayout {
  const isShown = (row: BacklogRowView): boolean => shown === undefined || shown.has(row.number)
  const byNumber = new Map(rows.map((row) => [row.number, row]))
  const epicRows = rows.filter(isEpic)
  const epicNumbers = new Set(epicRows.map((row) => row.number))

  // A nested epic takes up as many waves as it lays out, so its parent's numbers continue past it.
  const spans = new Map<number, number>()
  const spanning = new Set<number>()
  const spanOf = (number: number): number => {
    const row = byNumber.get(number)
    if (!row || !isEpic(row) || !row.children.ok || spanning.has(number)) return 1
    const known = spans.get(number)
    if (known !== undefined) return known
    spanning.add(number)
    const span = Math.max(1, placeMembers(row.children.children, spanOf).last)
    spanning.delete(number)
    spans.set(number, span)
    return span
  }

  const nestedNumbers = new Set<number>()
  for (const row of epicRows) {
    if (row.children.ok) {
      for (const child of row.children.children) if (child.number !== row.number && epicNumbers.has(child.number)) nestedNumbers.add(child.number)
    }
    if (row.parent.ok && row.parent.parent && row.parent.parent.number !== row.number && epicNumbers.has(row.parent.parent.number)) nestedNumbers.add(row.number)
  }

  const ctx: BuildContext = { rows, byNumber, placed: new Set<number>(), claimedEpics: new Set<number>(), isShown, spanOf }
  const placed = ctx.placed
  const groups = new Map<number, BacklogEpicGroup>()
  // Epics left unclaimed after the roots (a parent loop) are built as roots so none disappears.
  for (const row of [...epicRows.filter((epic) => !nestedNumbers.has(epic.number)), ...epicRows]) {
    if (ctx.claimedEpics.has(row.number)) continue
    const group = buildEpic(row, 1, ctx)
    if (group) groups.set(row.number, group)
  }
  const entries: BacklogLayoutEntry[] = []
  for (const row of rows) {
    const group = groups.get(row.number)
    if (group) entries.push({ kind: 'epic', group })
    else if (!isEpic(row) && !placed.has(row.number) && isShown(row)) entries.push({ kind: 'row', row })
  }
  // Array.prototype.sort is stable, so equal times keep the server's order.
  entries.sort((a, b) => {
    const [left, right] = [createdMs(entryCreatedAt(a)), createdMs(entryCreatedAt(b))]
    if (left === right) return 0
    return right > left ? 1 : -1
  })
  return { entries }
}
