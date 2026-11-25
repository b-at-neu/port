// An in-memory GitHub at the transport level: the reads answer from `items`, the `gh` writes mutate them. Anything else throws.
import { readFileSync } from 'node:fs'
import type { Platform } from '@/main/platform'
import type { CommandResult, GhResult, GitHubHttpResult } from '@/types/platform'

export interface FakeItem {
  readonly number: number
  readonly kind?: 'issue' | 'pull-request'
  readonly title?: string
  readonly state?: string
  readonly body?: string
  readonly labels?: readonly string[]
  readonly assignees?: readonly string[]
  readonly headRefName?: string
  readonly headRefOid?: string
}

interface HeldItem {
  readonly number: number
  readonly kind: 'issue' | 'pull-request'
  readonly title: string
  readonly state: string
  body: string
  labels: string[]
  assignees: string[]
  readonly headRefName: string
  readonly headRefOid: string
  comments: string[]
}

export interface FakeGitHub {
  readonly platform: Pick<Platform, 'githubHttp' | 'ghWrite' | 'git'>
  readonly labels: (number: number) => readonly string[]
  readonly assignees: (number: number) => readonly string[]
  readonly comments: (number: number) => readonly string[]
  readonly body: (number: number) => string
  /** Makes the next transport read fail with `message`, once. */
  readonly failNextRead: (message: string) => void
  /** Makes every comment write fail with `stderr`. */
  readonly failComments: (stderr: string) => void
  /** Makes every `gh` write to `number` fail with `stderr`; the next write to any item fails when `number` is `null`, once. */
  readonly failWrites: (number: number | null, stderr: string) => void
}

const NOT_A_REPOSITORY: CommandResult = { ok: false, kind: 'nonzero', code: 128, stdout: '', stderr: 'fatal: not a git repository' }

function nodeOf(item: HeldItem): Record<string, unknown> {
  return {
    __typename: item.kind === 'issue' ? 'Issue' : 'PullRequest',
    number: item.number,
    title: item.title,
    url: `https://github.com/o/r/${item.kind === 'issue' ? 'issues' : 'pull'}/${String(item.number)}`,
    state: item.state,
    body: item.body,
    closedAt: null,
    mergedAt: null,
    headRefName: item.headRefName,
    headRefOid: item.headRefOid,
    author: { login: 'author' },
    assignees: { nodes: item.assignees.map((login) => ({ login })) },
    labels: { nodes: item.labels.map((name) => ({ name })) },
    blockedBy: { totalCount: 0, nodes: [] },
  }
}

export function createFakeGitHub({ viewer = 'viewer', items }: { readonly viewer?: string; readonly items: readonly FakeItem[] }): FakeGitHub {
  const held = new Map<number, HeldItem>(
    items.map((item) => {
      const kind = item.kind ?? 'issue'
      return [item.number, { number: item.number, kind, title: item.title ?? `item ${String(item.number)}`, state: item.state ?? 'OPEN', body: item.body ?? '', labels: [...(item.labels ?? [])], assignees: [...(item.assignees ?? [])], headRefName: item.headRefName ?? (kind === 'pull-request' ? `${String(item.number)}-branch` : ''), headRefOid: item.headRefOid ?? 'abc123', comments: [] }]
    }),
  )
  let readFailure: string | null = null
  let nextWriteFailure: string | null = null
  let commentFailure: string | null = null
  const failingWrites = new Map<number, string>()

  const need = (number: number): HeldItem => {
    const item = held.get(number)
    if (item === undefined) throw new Error(`fake GitHub holds no item #${String(number)}`)
    return item
  }

  const githubHttp: Platform['githubHttp'] = (request) => {
    if (readFailure !== null) {
      const message = readFailure
      readFailure = null
      return Promise.resolve<GitHubHttpResult>({ ok: false, kind: 'unknown', status: 500, body: '', message })
    }
    const query = (JSON.parse(request.body ?? '{}') as { query?: string }).query ?? ''
    const repository: Record<string, unknown> = {}
    for (const match of query.matchAll(/(\w+): issueOrPullRequest\(number: (\d+)\)/g)) {
      const found = held.get(Number(match[2]))
      repository[match[1] ?? ''] = found === undefined ? null : nodeOf(found)
    }
    if (Object.keys(repository).length === 0) throw new Error(`fake GitHub does not answer this query: ${query.slice(0, 80)}`)
    return Promise.resolve<GitHubHttpResult>({ ok: true, status: 200, headers: {}, body: JSON.stringify({ data: { repository, viewer: { login: viewer } } }) })
  }

  const ghWrite: Platform['ghWrite'] = (argv) => {
    const [subcommand, verb, rawNumber, ...flags] = argv
    if ((subcommand !== 'issue' && subcommand !== 'pr') || rawNumber === undefined) throw new Error(`fake GitHub does not answer gh ${argv.join(' ')}`)
    const failure = nextWriteFailure ?? failingWrites.get(Number(rawNumber)) ?? (verb === 'comment' ? commentFailure : null)
    nextWriteFailure = null
    if (failure !== null) return Promise.resolve<GhResult>({ ok: false, kind: 'unknown', stdout: '', stderr: failure })
    const item = need(Number(rawNumber))
    const values = (flag: string): string[] => flags.flatMap((value, index) => (flags[index - 1] === flag ? [value] : []))
    if (verb === 'comment') {
      item.comments.push(readFileSync(values('--body-file')[0] ?? '', 'utf8'))
    } else if (verb === 'edit' && flags.includes('--body-file')) {
      item.body = readFileSync(values('--body-file')[0] ?? '', 'utf8')
    } else if (verb === 'edit') {
      item.labels = [...item.labels.filter((name) => !values('--remove-label').includes(name)), ...values('--add-label').filter((name) => !item.labels.includes(name))]
      item.assignees = [...item.assignees.filter((login) => !values('--remove-assignee').includes(login)), ...values('--add-assignee')]
    } else {
      throw new Error(`fake GitHub does not answer gh ${argv.join(' ')}`)
    }
    return Promise.resolve({ ok: true, stdout: '', stderr: '' })
  }

  return {
    platform: { githubHttp, ghWrite, git: () => Promise.resolve(NOT_A_REPOSITORY) },
    labels: (number) => need(number).labels,
    assignees: (number) => need(number).assignees,
    comments: (number) => need(number).comments,
    body: (number) => need(number).body,
    failNextRead: (message) => {
      readFailure = message
    },
    failComments: (stderr) => {
      commentFailure = stderr
    },
    failWrites: (number, stderr) => {
      if (number === null) nextWriteFailure = stderr
      else failingWrites.set(number, stderr)
    },
  }
}
