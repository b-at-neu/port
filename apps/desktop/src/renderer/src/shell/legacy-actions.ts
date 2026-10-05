// A registry `main.ts` fills in and the shell calls, so the shell's own
// files never import `main.ts` directly.
import type { RepoId } from '../../../shared/repos'

export interface LegacyActions {
  openSessions(repoId: RepoId): void
}

let actions: LegacyActions | null = null

export function registerLegacyActions(next: LegacyActions): void {
  actions = next
}

export function legacyActions(): LegacyActions | null {
  return actions
}
