import { fetchAppReleases } from '@/main/github/app-releases'
import type { AppContext } from '@/main/app/context'
import { checkGate, classifyUpdate, selectLatestRelease } from '@/main/features/update/select'

import type { UpdateService, UpdateState, UpdateTrigger } from '@/types/update'
import type { ParsedVersion } from '@/utils/release/version'

/** Holds one state; fails toward showing nothing, so every failure becomes an `error` value. `repo` is the `owner/name` whose releases are read. */
export function createUpdateService(ctx: Pick<AppContext, 'info' | 'updates' | 'githubPublic' | 'clock'>, { repo }: { readonly repo: string }): UpdateService {
  const version = ctx.info().app
  const gate = checkGate({ isPackaged: ctx.updates.isPackaged, version })
  const [owner = '', name = ''] = repo.split('/')
  let state: UpdateState = gate.ok ? { kind: 'idle', current: version } : { kind: 'disabled', reason: gate.reason, current: version }
  let inFlight: Promise<UpdateState> | null = null

  async function run(current: ParsedVersion, trigger: UpdateTrigger): Promise<UpdateState> {
    try {
      state = { kind: 'checking', current: version, trigger, startedAt: ctx.clock.now().toISOString() }
      const result = await fetchAppReleases(ctx, { owner, name })
      const checkedAt = ctx.clock.now().toISOString()
      if (!result.ok) {
        console.warn('[update] check failed', result.reason)
        return { kind: 'error', current: version, reason: result.reason, detail: result.detail, trigger, checkedAt }
      }
      const outcome = classifyUpdate(current, selectLatestRelease(result.releases))
      if (outcome.kind === 'available') return { kind: 'available', current: version, release: outcome.release, trigger, checkedAt }
      return { kind: 'up-to-date', current: version, latest: outcome.latest, trigger, checkedAt }
    } catch (error) {
      console.warn('[update] check failed', 'unavailable')
      return { kind: 'error', current: version, reason: 'unavailable', detail: error instanceof Error ? error.message : String(error), trigger, checkedAt: ctx.clock.now().toISOString() }
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
