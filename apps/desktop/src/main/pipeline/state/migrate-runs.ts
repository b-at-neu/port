// Pure: the version 3 file, from the version 2 pipeline state and the three run files it replaces.
import { capped } from '@/main/pipeline/runs'
import { ticketOfKeys } from '@/main/pipeline/state/migrate'
import { RUN_STATES } from '@/types/dispatch'
import type { DispatchEntry } from '@/types/pipeline-state'
import { INTERRUPTED_REASONS, runSchema, STAGE_AGENTS, type Run, type Stage } from '@/utils/pipeline/ticket'
import type { LabelKey } from '@/utils/labels/vocabulary'
import type { RepoId } from '@/utils/repos'

/** The raw JSON of the three files, `null` for one that was missing or unparseable. */
export interface RunFiles {
  readonly dispatch: unknown
  readonly sessions: unknown
  readonly denials: unknown
}

export const NO_RUN_FILES: RunFiles = { dispatch: null, sessions: null, denials: null }

type Agent = (typeof STAGE_AGENTS)[number]
type Json = Record<string, unknown>
interface Denial {
  readonly id: string
  readonly repoId: string
  readonly agent: Agent
  readonly number: number
  readonly toolName: string
  readonly inputSummary: string
  readonly rule: string
  readonly at: string
}

const STAGE_OF_AGENT: Readonly<Record<Agent, Stage>> = { plan: 'plan', impl: 'implement', review: 'review', revise: 'revise' }
const TRIGGER_OF_AGENT: Readonly<Record<Agent, LabelKey>> = { plan: 'ready', impl: 'planApproved', review: 'readyForReview', revise: 'needsRevision' }
const KIND_OF_AGENT: Readonly<Record<Agent, 'issue' | 'pull-request'>> = { plan: 'issue', impl: 'issue', review: 'pull-request', revise: 'pull-request' }
const DENIAL_LIMIT = 20

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function entriesOf(file: unknown): readonly unknown[] {
  return isRecord(file) && Array.isArray(file.entries) ? file.entries : []
}

const isAgent = (value: unknown): value is Agent => STAGE_AGENTS.some((agent) => agent === value)
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** Version 2 of `dispatch.json`; any other version or a missing file reads every repository as paused. */
function dispatchOf(file: unknown): Record<string, DispatchEntry> {
  const out: Record<string, DispatchEntry> = {}
  if (!isRecord(file) || file.version !== 2 || !Array.isArray(file.repositories)) return out
  for (const raw of file.repositories) {
    if (!isRecord(raw) || typeof raw.id !== 'string') continue
    const state = RUN_STATES.find((candidate) => candidate === raw.state)
    if (state !== undefined) out[raw.id] = { state, since: text(raw.since) }
  }
  return out
}

function registryRun(raw: unknown): { readonly repoId: string; readonly run: Run } | null {
  if (!isRecord(raw) || typeof raw.repoId !== 'string' || !isAgent(raw.agent)) return null
  const interrupted = raw.state === 'interrupted'
  const interruptedAt = text(raw.interruptedAt) ?? text(raw.startedAt)
  const reason = INTERRUPTED_REASONS.find((candidate) => candidate === raw.reason)
  const stage: Stage = raw.trigger === 'refreshBranch' ? 'refresh' : STAGE_OF_AGENT[raw.agent]
  const parsed = runSchema.safeParse({
    id: raw.id,
    stage,
    item: { kind: raw.kind, number: raw.number },
    agent: raw.agent,
    trigger: raw.trigger,
    model: raw.model,
    title: text(raw.title),
    sessionKey: null,
    claudeSessionId: raw.claudeSessionId,
    worktree: raw.worktree,
    startedAt: raw.startedAt,
    endedAt: interrupted ? interruptedAt : null,
    outcome: null,
    handback: null,
    costUsd: typeof raw.costUsd === 'number' ? raw.costUsd : null,
    operatorJoinedAt: null,
    failure: null,
    interruption: interrupted && reason !== undefined ? { reason, detail: text(raw.detail), at: interruptedAt, resetsAt: text(raw.resetsAt) } : null,
    networkRetries: typeof raw.networkRetries === 'number' ? raw.networkRetries : 0,
    denials: [],
  })
  if (!parsed.success) {
    console.error(`[pipeline-state] dropped run ${String(raw.id)}: ${parsed.error.message}`)
    return null
  }
  return { repoId: raw.repoId, run: parsed.data }
}

function denialOf(raw: unknown): Denial | null {
  if (!isRecord(raw) || !isAgent(raw.agent)) return null
  const { id, repoId, number, toolName, inputSummary, rule, at } = raw
  if (typeof id !== 'string' || id === '' || typeof repoId !== 'string' || typeof number !== 'number' || typeof toolName !== 'string' || typeof inputSummary !== 'string' || typeof rule !== 'string' || typeof at !== 'string') return null
  return { id, repoId, agent: raw.agent, number, toolName, inputSummary, rule, at }
}

/** A repository's tickets as they are in the file, with the runs this migration adds. */
interface Repo {
  readonly seededAt: unknown
  readonly tickets: Record<string, Json>
}

function holds(ticket: Json, kind: 'issue' | 'pull-request', number: number): boolean {
  const pr = isRecord(ticket.pr) ? ticket.pr.number : null
  return kind === 'issue' ? ticket.ticket === number && pr !== number : pr === number
}

function ticketFor(repo: Repo, kind: 'issue' | 'pull-request', number: number): Json | null {
  return Object.values(repo.tickets).find((ticket) => holds(ticket, kind, number)) ?? null
}

function stubFor(repoId: string, run: Run): Json {
  const { item } = run
  const keys: LabelKey[] = []
  const pr = item.kind === 'pull-request' ? { number: item.number, keys, approvedAt: null } : null
  const { ticket } = ticketOfKeys({ repo: repoId as RepoId, ticket: item.number, issueKeys: [], pr, history: [], at: run.startedAt, mirrorFailure: null, reviewCycles: 0, stageHint: run.stage })
  return ticket
}

function runsOf(ticket: Json): Run[] {
  return Array.isArray(ticket.runs) ? (ticket.runs as Run[]) : []
}

function withDenials(run: Run, denials: readonly Denial[]): Run {
  const all = [...run.denials, ...denials.map(({ id, toolName, inputSummary, rule, at }) => ({ id, toolName, inputSummary, rule, at }))]
  const newest = all.filter((denial) => !all.some((other) => other.rule === denial.rule && other.at > denial.at))
  return { ...run, denials: newest.sort((a, b) => a.at.localeCompare(b.at)).slice(-DENIAL_LIMIT) }
}

function denialRun(denials: readonly Denial[], first: Denial): Run {
  const newest = denials.reduce((latest, denial) => (denial.at > latest ? denial.at : latest), first.at)
  return {
    id: `migrated-${first.id}`,
    stage: STAGE_OF_AGENT[first.agent],
    item: { kind: KIND_OF_AGENT[first.agent], number: first.number },
    agent: first.agent,
    trigger: TRIGGER_OF_AGENT[first.agent],
    model: '',
    title: null,
    sessionKey: null,
    claudeSessionId: null,
    worktree: null,
    startedAt: newest,
    endedAt: newest,
    outcome: null,
    handback: null,
    costUsd: null,
    operatorJoinedAt: null,
    failure: null,
    interruption: null,
    networkRetries: 0,
    denials: [],
  }
}

/** Version 2's repositories as mutable records; a repository that is not one is dropped, as `parseFile` would. */
function reposOf(file: Json): Record<string, Repo> {
  const repos: Record<string, Repo> = {}
  if (!isRecord(file.repositories)) return repos
  for (const [repoId, raw] of Object.entries(file.repositories)) {
    if (!isRecord(raw) || !isRecord(raw.tickets)) continue
    const tickets: Record<string, Json> = {}
    for (const [key, ticket] of Object.entries(raw.tickets)) if (isRecord(ticket)) tickets[key] = { ...ticket, runs: runsOf(ticket).filter((run) => runSchema.safeParse(run).success) }
    repos[repoId] = { seededAt: raw.seededAt, tickets }
  }
  return repos
}

function place(repos: Record<string, Repo>, repoId: string, run: Run): boolean {
  const repo = repos[repoId]
  if (repo === undefined) return false
  const held = ticketFor(repo, run.item.kind, run.item.number) ?? stubFor(repoId, run)
  repo.tickets[String(held.ticket)] = { ...held, runs: [...runsOf(held), run] }
  return true
}

function attach(repos: Record<string, Repo>, denial: Denial): boolean {
  const repo = repos[denial.repoId]
  if (repo === undefined) return false
  const held = ticketFor(repo, KIND_OF_AGENT[denial.agent], denial.number)
  const runs = held === null ? [] : runsOf(held)
  const target = runs.filter((run) => run.agent === denial.agent && run.startedAt <= denial.at).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
  if (held === null || target === undefined) return false
  repo.tickets[String(held.ticket)] = { ...held, runs: runs.map((run) => (run === target ? withDenials(run, [denial]) : run)) }
  return true
}

/** The version 3 file: registry entries and denials become runs on their tickets, and `dispatch.json` becomes the `dispatch` section. History and `rev` are untouched. */
export function migrateRuns(v2: unknown, files: RunFiles): unknown {
  if (!isRecord(v2)) throw new Error('pipeline state is not an object')
  const repos = reposOf(v2)

  for (const raw of entriesOf(files.sessions)) {
    const entry = registryRun(raw)
    if (entry === null) continue
    // The newest append of an id wins, so a repeated id replaces its earlier run.
    const repo = repos[entry.repoId]
    if (repo !== undefined) for (const [key, ticket] of Object.entries(repo.tickets)) repo.tickets[key] = { ...ticket, runs: runsOf(ticket).filter((run) => run.id !== entry.run.id) }
    if (!place(repos, entry.repoId, entry.run)) console.error(`[pipeline-state] dropped run ${entry.run.id}: ${entry.repoId} has no seeded record`)
  }

  const denials = entriesOf(files.denials).flatMap((raw) => denialOf(raw) ?? [])
  const unplaced = denials.filter((denial) => !attach(repos, denial))
  const groups = new Map<string, Denial[]>()
  for (const denial of unplaced) groups.set(`${denial.repoId}#${String(denial.number)}#${denial.agent}`, [...(groups.get(`${denial.repoId}#${String(denial.number)}#${denial.agent}`) ?? []), denial])
  for (const group of groups.values()) {
    const [first] = group
    if (first === undefined) continue
    const run = withDenials(denialRun(group, first), group)
    if (!place(repos, first.repoId, run)) console.error(`[pipeline-state] dropped ${String(group.length)} denial(s) of ${first.repoId}: it has no seeded record`)
  }

  const repositories = Object.fromEntries(
    Object.entries(repos).map(([repoId, repo]) => [repoId, { seededAt: repo.seededAt, tickets: Object.fromEntries(Object.entries(repo.tickets).map(([key, ticket]) => [key, { ...ticket, runs: capped(runsOf(ticket)) }])) }]),
  )
  return { version: 3, dispatch: dispatchOf(files.dispatch), repositories }
}
