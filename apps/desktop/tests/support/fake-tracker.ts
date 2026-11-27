// A scripted tracker for tests that decide on what an issue read returns, and a real tracker over a fake transport for tests that script the wire.
import { createGithubTracker, type Tracker } from '@/main/github/tracker'
import type { GitHubTransport } from '@/types/platform'
import { createFakePlatform } from './fake-platform'

/** A member the test did not script throws when called, so no action silently runs against a stand-in. */
export function createFakeTracker(given: Partial<Tracker>): Tracker {
  return new Proxy(given, {
    get(target, key, receiver) {
      if (key in target) return Reflect.get(target, key, receiver) as unknown
      if (typeof key === 'symbol' || key === 'then') return undefined
      throw new Error(`ctx.tracker.${key} is not scripted`)
    },
  }) as Tracker
}

/** The real GitHub tracker reading through `githubHttp`. */
export function trackerOver(githubHttp: GitHubTransport): Tracker {
  return createGithubTracker({ ...createFakePlatform(), githubHttp })
}
