// A test context for the operator flows: one ready repository, a seeded record store, a fake GitHub and a scratch directory.
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppContext } from '@/main/app/context'
import type { ReadyEntry } from '@/types/actions'
import type { BoardSnapshot } from '@/types/board'
import type { HostedSessionSnapshot } from '@/types/hosting'
import type { IncidentDraft } from '@/types/incidents'
import type { Ticket } from '@/utils/pipeline/ticket'
import { boardSnapshot } from './board-snapshot'
import { createTestContext } from './context'
import { createFakeFs } from './fake-platform'
import { createFakeGitHub, type FakeItem } from './fake-github'
import { readyEntry } from './repo-config'
import { AT } from './state-store'

export const REPO_ID = 'repo-a' as ReadyEntry['id']

export interface OperatorRigOptions {
  readonly items?: readonly FakeItem[]
  /** `null` leaves the repository unseeded. */
  readonly tickets?: readonly Ticket[] | null
  readonly viewer?: string
  readonly unreadableOwnership?: boolean
  /** The repository is owned by the app, so its ownership reads `app`. */
  readonly appOwned?: boolean
  readonly entry?: ReadyEntry
  readonly live?: Partial<AppContext['live']>
}

/** A watcher that records each forced refresh, and throws from it when asked. */
export function recordingWatcher(options: { readonly failRefresh?: boolean; readonly snapshot?: BoardSnapshot; readonly sessions?: readonly HostedSessionSnapshot[] } = {}) {
  const refreshes: unknown[] = []
  const snapshot = options.snapshot ?? boardSnapshot()
  const watcher = {
    snapshot: () => snapshot,
    refresh: (request?: unknown) => {
      refreshes.push(request)
      return options.failRefresh === true ? Promise.reject(new Error('transient github error')) : Promise.resolve(snapshot)
    },
  } as unknown as AppContext['live']['watcher']
  const hostedStore = { list: () => options.sessions ?? [] } as unknown as AppContext['live']['hostedStore']
  return { watcher, refreshes, live: { watcher, hostedStore } }
}

export async function operatorRig(options: OperatorRigOptions = {}) {
  const entry = options.entry ?? readyEntry({ id: REPO_ID })
  const github = createFakeGitHub({ viewer: options.viewer, items: options.items ?? [] })
  const fs = createFakeFs()
  const incidents: IncidentDraft[] = []
  const incidentLog = { record: (draft: IncidentDraft) => Promise.resolve(void incidents.push(draft)), read: () => Promise.reject(new Error('unused')) }
  const tickets = options.tickets === undefined ? [] : options.tickets
  const auditDir = await mkdtemp(join(tmpdir(), 'port-operator-'))
  const ctx = createTestContext({
    platform: { ...github.platform, fs, paths: { userData: auditDir, temp: auditDir, logs: auditDir } },
    repositories: [entry],
    ...(tickets === null ? {} : { tickets: { repoId: entry.id, tickets } }),
    stores: { incidentLog },
    ...(options.live === undefined ? {} : { live: options.live }),
  })
  await ctx.ready
  if (options.unreadableOwnership === true) await fs.writeText(`${entry.path}/.agents/cockpit.json`, JSON.stringify({ repo: entry.config.repo, owner: 'terminal', since: AT }))
  if (options.appOwned === true) await fs.writeText(`${entry.path}/.agents/cockpit.json`, JSON.stringify({ repo: entry.config.repo, owner: 'app', since: AT }))
  return {
    ctx,
    github,
    entry,
    auditDir,
    scratchDir: auditDir,
    incidents,
    ticket: (number: number, kind: 'issue' | 'pull-request' = 'issue') => ctx.stores.pipelineState.ticket(entry.id, { kind, number }),
  }
}
