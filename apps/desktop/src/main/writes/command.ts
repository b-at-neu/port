// Resolves every LabelKey a write request carries through
// `labelName(vocabulary, key)` and returns either the unresolved keys or the
// exact `gh` argv. The only file in the app allowed to name `--add-label`/
// `--remove-label` — pinned by `scripts/checks/desktop-writes.mjs`. Pure: no
// `gh`, no filesystem.
import { labelName } from '../../shared/labels/vocabulary'
import type { LabelKey } from '../../shared/labels/vocabulary'
import type { LabelWriteRequest } from '../../shared/writes/types'

export interface ResolvedNames {
  readonly addNames: readonly string[]
  readonly removeNames: readonly string[]
}

export type BuildCommandResult = ({ readonly ok: true; readonly argv: readonly string[] } & ResolvedNames) | { readonly ok: false; readonly unresolved: readonly LabelKey[] }

/** A module-disabled or unknown key resolves to nothing — a config
 *  condition `labelName` already reports, answerable with no round trip.
 *  Resolution failure aborts the whole request rather than dropping the
 *  unresolved key silently. */
function resolveKeys(vocabulary: LabelWriteRequest['vocabulary'], keys: readonly LabelKey[], unresolved: LabelKey[]): string[] {
  const names: string[] = []
  for (const key of keys) {
    const name = labelName(vocabulary, key)
    if (name === undefined) unresolved.push(key)
    else names.push(name)
  }
  return names
}

/** Builds `['issue'|'pr', 'edit', String(n), '--repo', repo, '--add-label',
 *  name, …, '--remove-label', name, …, '--add-assignee', login, …,
 *  '--remove-assignee', login, …]` — never `merge`, `close`,
 *  `--delete-branch`, or `ready`, which stay human actions on GitHub. */
export function buildCommand(request: LabelWriteRequest): BuildCommandResult {
  const unresolved: LabelKey[] = []
  const addNames = resolveKeys(request.vocabulary, request.add, unresolved)
  const removeNames = resolveKeys(request.vocabulary, request.remove, unresolved)
  if (unresolved.length > 0) return { ok: false, unresolved }

  const subcommand = request.kind === 'pull-request' ? 'pr' : 'issue'
  const argv: string[] = [subcommand, 'edit', String(request.number), '--repo', request.repo]
  for (const name of addNames) argv.push('--add-label', name)
  for (const name of removeNames) argv.push('--remove-label', name)
  for (const login of request.addAssignees) argv.push('--add-assignee', login)
  for (const login of request.removeAssignees) argv.push('--remove-assignee', login)

  return { ok: true, argv, addNames, removeNames }
}
