// The public surface `main/state/watcher.ts` imports — never `./log` or
// `./types` directly.
export { buildDesktopTickEvent, recordTick } from './log'
export type { GitRunner as TrajectoryGitRunner, RecordTickDeps } from './log'

export type { DesktopClaimEvent, DesktopDispatchEvent, DesktopHeldEvent, DesktopTickEvent } from './types'
