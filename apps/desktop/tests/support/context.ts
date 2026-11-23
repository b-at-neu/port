// An in-memory AppContext, and the call that runs an action exactly as the router does.
import type { AppContext } from '@/main/app/context'
import { actions } from '@/main/app/router'
import { createStageRegistry } from '@/main/dispatch/stage/registry'
import { createSessionIndex } from '@/main/sessions/hosting/session-index'
import { createUsageLedger } from '@/main/sessions/hosting/usage-ledger'
import type { Platform } from '@/main/platform'
import { readyOf, type Repos } from '@/main/repos'
import type { EventMap, EventName } from '@/main/app/events'
import type { ActionInput, ActionName, ActionOutput } from '@/types/ipc'
import type { RepositoryEntry } from '@/utils/repos'
import { createFakePlatform, type FakePlatform } from './fake-platform'

export interface TestContextOptions {
  readonly platform?: Partial<Platform>
  readonly repositories?: readonly RepositoryEntry[]
  readonly repos?: Partial<Repos>
  readonly stores?: Partial<AppContext['stores']>
  readonly live?: Partial<AppContext['live']>
  readonly seams?: Partial<AppContext['seams']>
}

export type TestContext = AppContext & {
  readonly clock: FakePlatform['clock']
  readonly emitted: { readonly event: EventName; readonly payload: unknown }[]
}

/** A member the test did not pass throws on read, so no action silently runs against a stand-in. */
function unscriptedGroup<T extends object>(group: string, given: Partial<T>): T {
  return new Proxy(given, {
    get(target, key, receiver) {
      if (key in target) return Reflect.get(target, key, receiver) as unknown
      if (typeof key === 'symbol' || key === 'then') return undefined
      throw new Error(`ctx.${group}.${key} is not in this test context; pass it to createTestContext`)
    },
  }) as T
}

function memoryRepos(seed: readonly RepositoryEntry[], platform: Platform): Omit<Repos, 'deps'> {
  let entries = [...seed]
  const repos = {
    list: () => Promise.resolve({ ok: true as const, repositories: entries }),
    resolve: (repoId) => Promise.resolve(readyOf({ ok: true, repositories: entries }, repoId)),
    remove: (id) => {
      const remaining = entries.filter((entry) => entry.id !== id)
      if (remaining.length === entries.length) return Promise.resolve({ ok: false as const, kind: 'not-registered' as const, message: `no repository is registered with id '${id}'` })
      entries = remaining
      return Promise.resolve({ ok: true as const, repositories: entries })
    },
    add: async () => {
      const picked = await platform.dialogs.chooseDirectory()
      if (picked === null) return { ok: true as const, outcome: 'cancelled' as const }
      throw new Error('repos.add picked a directory; pass repos.add to createTestContext')
    },
  } satisfies Omit<Repos, 'deps'>
  return repos
}

export function createTestContext(options: TestContextOptions = {}): TestContext {
  const fake = createFakePlatform()
  const platform: FakePlatform = { ...fake, ...options.platform, clock: fake.clock }
  const emitted: TestContext['emitted'] = []

  const repos = { ...memoryRepos(options.repositories ?? [], platform), ...options.repos } as Repos
  if (options.repos?.deps === undefined) {
    Object.defineProperty(repos, 'deps', {
      enumerable: true,
      get: () => {
        throw new Error('ctx.repos.deps reads the real registry file; pass repos to createTestContext')
      },
    })
  }

  const path = (file: string): string => `${platform.paths.userData}/${file}`
  const stores = {
    stageRegistry: createStageRegistry({ path: path('stage-sessions.json'), readJson: platform.fs.readJson, writeJsonAtomic: platform.fs.writeJsonAtomic, now: platform.clock.now }),
    sessionIndex: createSessionIndex({ path: path('session-index.json'), readJson: platform.fs.readJson, writeJsonAtomic: platform.fs.writeJsonAtomic, now: platform.clock.now }),
    usageLedger: createUsageLedger({ path: path('usage-ledger.json'), readJson: platform.fs.readJson, writeJsonAtomic: platform.fs.writeJsonAtomic, now: platform.clock.now, bootId: 'test-boot' }),
    ...options.stores,
  }

  return {
    ...platform,
    emit: <E extends EventName>(event: E, payload: EventMap[E]) => {
      emitted.push({ event, payload })
    },
    emitted,
    repos,
    stores: unscriptedGroup('stores', stores),
    live: unscriptedGroup('live', options.live ?? {}),
    seams: unscriptedGroup('seams', options.seams ?? {}),
  }
}

/** Runs an action exactly as the router does: parse the raw request, then `run`. */
export async function callAction<N extends ActionName>(ctx: AppContext, name: N, input?: ActionInput<N>): Promise<ActionOutput<N>> {
  const action = actions.find((candidate) => candidate.name === name)
  if (action === undefined) throw new Error(`no action named '${name}'`)
  const run = action.run as (ctx: AppContext, input: unknown) => unknown
  return (await run(ctx, action.input.parse(input))) as ActionOutput<N>
}
