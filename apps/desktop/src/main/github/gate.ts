// fetchGatePreflight — the plan gate's own one round trip. A new file to stay clear of the
// file-size ratchet; reuses envelope.ts's parsing rather than hand-rolling a second reader.
import { gh as defaultGh } from '../platform/gh'
import type { GhResult, GhRunner } from '../platform/gh'
import type { GatePreflightFetch, GatePreflightItem } from '../../shared/github/types'
import { classifyFailure, parseEnvelope } from './envelope'
import { fieldListOf } from './map'
import { buildGatePreflightQuery } from './query'
import type { RepoRef } from './adapter'

export type { GhRunner }

function stdoutOf(result: GhResult): string | undefined {
  return 'stdout' in result ? result.stdout : undefined
}

function kindOfTypename(typename: unknown): 'issue' | 'pull-request' | undefined {
  if (typename === 'Issue') return 'issue'
  if (typename === 'PullRequest') return 'pull-request'
  return undefined
}

export interface FetchGatePreflightParams {
  readonly repo: RepoRef
  readonly number: number
  readonly gh?: GhRunner
  readonly now?: () => Date
}

/** The plan gate's one round trip: one issue's identity, labels, assignees, body, and the
 *  signed-in account's login. `item: null` covers "does not exist" or "alias errored", neither a failure. */
export async function fetchGatePreflight(params: FetchGatePreflightParams): Promise<GatePreflightFetch> {
  const runner = params.gh ?? defaultGh
  const now = params.now ?? (() => new Date())
  const fetchedAt = now().toISOString()

  const { document } = buildGatePreflightQuery(params.number)
  const ghResult = await runner(['api', 'graphql', '-f', `query=${document}`, '-f', `owner=${params.repo.owner}`, '-f', `name=${params.repo.name}`])

  const stdout = stdoutOf(ghResult)
  const parsed = stdout !== undefined ? parseEnvelope(stdout) : undefined
  const verdict = classifyFailure(ghResult, parsed)

  if (verdict.kind !== 'ok') {
    return { ok: false, kind: verdict.kind, message: verdict.message, fetchedAt }
  }
  if (parsed === undefined || !parsed.ok) {
    return { ok: false, kind: 'no-data', message: 'internal: an ok verdict without a parsed envelope', fetchedAt }
  }
  const body = parsed.value
  if (body.data === undefined || body.data === null || body.data.repository === undefined || body.data.repository === null) {
    return { ok: false, kind: 'no-data', message: 'internal: an ok verdict without usable repository data', fetchedAt }
  }
  const repository = body.data.repository as Readonly<Record<string, unknown>>
  const errors = body.errors ?? []

  const viewerErrored = errors.some((error) => error.path?.[0] === 'viewer')
  const viewerNode = body.data.viewer
  const viewerLogin = typeof viewerNode === 'object' && viewerNode !== null ? (viewerNode as Record<string, unknown>).login : undefined
  if (viewerErrored || typeof viewerLogin !== 'string' || viewerLogin === '') {
    return { ok: false, kind: 'no-data', message: "could not resolve the signed-in account's login", fetchedAt }
  }

  const itemErrored = errors.some((error) => error.path?.[1] === 'c0' && error.path.length === 2)
  const node = repository.c0
  const kind = itemErrored || typeof node !== 'object' || node === null ? undefined : kindOfTypename((node as Record<string, unknown>).__typename)
  if (kind === undefined) {
    return { ok: true, item: null, viewer: viewerLogin, fetchedAt }
  }
  const raw = node as Record<string, unknown>

  const item: GatePreflightItem = {
    kind,
    number: typeof raw.number === 'number' ? raw.number : params.number,
    title: typeof raw.title === 'string' ? raw.title : '',
    url: typeof raw.url === 'string' ? raw.url : '',
    state: typeof raw.state === 'string' ? raw.state : '',
    body: kind === 'issue' && typeof raw.body === 'string' ? raw.body : '',
    labels: kind === 'issue' ? fieldListOf(raw.labels, 'name') : [],
    assignees: kind === 'issue' ? fieldListOf(raw.assignees, 'login') : [],
  }

  return { ok: true, item, viewer: viewerLogin, fetchedAt }
}
