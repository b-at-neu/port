// readItemStates — the state of many issues or pull requests in one aliased round trip.
import { gh as defaultGh } from '@/main/platform/gh'
import type { GitHubRepoRef, ItemStateName, ItemStatesRead } from '@/types/github'
import type { GhRunner } from '@/types/platform'
import { classifyFailure, parseEnvelope, stdoutOf } from '@/main/github/envelope'

interface ReadItemStatesParams {
  readonly repo: GitHubRepoRef
  readonly numbers: readonly number[]
  readonly gh?: GhRunner
}

function stateOf(node: unknown): ItemStateName | null {
  if (typeof node !== 'object' || node === null) return null
  const state = (node as Record<string, unknown>).state
  return state === 'OPEN' || state === 'CLOSED' || state === 'MERGED' ? state : null
}

/** An alias named in `errors[].path`, or one that came back absent, maps to `null` — a failure to read an item never reads as done. */
export async function readItemStates(params: ReadItemStatesParams): Promise<ItemStatesRead> {
  const states = new Map<number, ItemStateName | null>()
  if (params.numbers.length === 0) return { ok: true, states }

  const aliases = params.numbers.map((n) => `n${String(n)}: issueOrPullRequest(number: ${String(n)}) { __typename ... on Issue { state } ... on PullRequest { state } }`)
  const document = ['query($owner: String!, $name: String!) {', '  repository(owner: $owner, name: $name) {', `    ${aliases.join(' ')}`, '  }', '}'].join('\n')

  const runner = params.gh ?? defaultGh
  const result = await runner(['api', 'graphql', '-f', `query=${document}`, '-f', `owner=${params.repo.owner}`, '-f', `name=${params.repo.name}`])
  const stdout = stdoutOf(result)
  const parsed = stdout !== undefined ? parseEnvelope(stdout) : undefined
  const verdict = classifyFailure(result, parsed)
  if (verdict.kind !== 'ok') return { ok: false, kind: verdict.kind, message: verdict.message }
  if (parsed === undefined || !parsed.ok) return { ok: false, kind: 'unparseable', message: "GitHub's reply wasn't JSON" }

  const body = parsed.value
  const repository = (body.data?.repository ?? {}) as Readonly<Record<string, unknown>>
  const errored = new Set((body.errors ?? []).map((error) => error.path?.[1]))
  for (const n of params.numbers) {
    const alias = `n${String(n)}`
    states.set(n, errored.has(alias) ? null : stateOf(repository[alias]))
  }
  return { ok: true, states }
}
