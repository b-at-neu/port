// The one import point for every issue-side read and write. The schema's `tracker` enum is still `github`, so this reads no config.
import { createGithubTracker } from '@/main/github/tracker'
import type { ConditionalTransport, GitHubTransport } from '@/types/platform'
import type { Tracker } from '@/types/tracker'

interface TrackerTransports {
  readonly github?: GitHubTransport
  readonly conditional?: ConditionalTransport
  readonly now?: () => Date
}

export function createTracker(transports: TrackerTransports): Tracker {
  return createGithubTracker(transports)
}

export const defaultTracker: Tracker = createTracker({})
