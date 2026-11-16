import { checkGate, classifyUpdate, selectLatestRelease } from '@/main/update/select'

import type { FetchReleasesResult, UpdateService, UpdateState, UpdateTrigger } from '@/types/update'
import type { ParsedVersion } from '@/utils/release/version'

export interface UpdateServiceDeps {
  readonly version: string
  readonly isPackaged: boolean
  /** `owner/name` of the repository whose releases are read. */
  readonly repo: string
  readonly fetchReleases: (repo: { readonly owner: string; readonly name: string }) => Promise<FetchReleasesResult>
  readonly now: () => Date
}

/** Holds one state; fails toward showing nothing, so every failure becomes an `error` value. */
export function createUpdateService(deps: UpdateServiceDeps): UpdateService {
  const gate = checkGate({ isPackaged: deps.isPackaged, version: deps.version })
  const [owner = '', name = ''] = deps.repo.split('/')
  let state: UpdateState = gate.ok ? { kind: 'idle', current: deps.version } : { kind: 'disabled', reason: gate.reason, current: deps.version }
  let inFlight: Promise<UpdateState> | null = null

  async function run(current: ParsedVersion, trigger: UpdateTrigger): Promise<UpdateState> {
    try {
      state = { kind: 'checking', current: deps.version, trigger, startedAt: deps.now().toISOString() }
      const result = await deps.fetchReleases({ owner, name })
      const checkedAt = deps.now().toISOString()
      if (!result.ok) {
        console.warn('[update] check failed', result.reason)
        return { kind: 'error', current: deps.version, reason: result.reason, detail: result.detail, trigger, checkedAt }
      }
      const outcome = classifyUpdate(current, selectLatestRelease(result.releases))
      if (outcome.kind === 'available') return { kind: 'available', current: deps.version, release: outcome.release, trigger, checkedAt }
      return { kind: 'up-to-date', current: deps.version, latest: outcome.latest, trigger, checkedAt }
    } catch (error) {
      console.warn('[update] check failed', 'unavailable')
      return { kind: 'error', current: deps.version, reason: 'unavailable', detail: error instanceof Error ? error.message : String(error), trigger, checkedAt: deps.now().toISOString() }
    }
  }

  return {
    state: () => state,
    check: (trigger) => {
      if (!gate.ok) return Promise.resolve(state)
      if (inFlight !== null) return inFlight
      const pending = run(gate.current, trigger).then((next) => {
        state = next
        inFlight = null
        return next
      })
      inFlight = pending
      return pending
    },
  }
}
