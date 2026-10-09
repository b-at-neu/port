// The only file in the app allowed to name `--add-label`/`--remove-label`. Pure: no `gh`, no filesystem.
import { labelName } from '../../shared/labels/vocabulary'
import type { LabelKey, LabelVocabulary } from '../../shared/labels/vocabulary'
import type { LabelWriteRequest } from '../../shared/writes/types'

export interface ResolvedNames {
  readonly addNames: readonly string[]
  readonly removeNames: readonly string[]
}

export type BuildCommandResult = ({ readonly ok: true; readonly argv: readonly string[] } & ResolvedNames) | { readonly ok: false; readonly unresolved: readonly LabelKey[] }

export interface KeyResolution {
  readonly names: string[]
  readonly unresolved: LabelKey[]
}

// Resolution failure aborts the whole request rather than dropping the unresolved key silently.
export function resolveKeys(vocabulary: LabelVocabulary, keys: readonly LabelKey[]): KeyResolution {
  const names: string[] = []
  const unresolved: LabelKey[] = []
  for (const key of keys) {
    const name = labelName(vocabulary, key)
    if (name === undefined) unresolved.push(key)
    else names.push(name)
  }
  return { names, unresolved }
}

// Never `merge`, `close`, `--delete-branch`, or `ready`, which stay human actions on GitHub.
export function buildCommand(request: LabelWriteRequest): BuildCommandResult {
  const add = resolveKeys(request.vocabulary, request.add)
  const remove = resolveKeys(request.vocabulary, request.remove)
  const unresolved = [...add.unresolved, ...remove.unresolved]
  if (unresolved.length > 0) return { ok: false, unresolved }

  const subcommand = request.kind === 'pull-request' ? 'pr' : 'issue'
  const argv: string[] = [subcommand, 'edit', String(request.number), '--repo', request.repo]
  for (const name of add.names) argv.push('--add-label', name)
  for (const name of remove.names) argv.push('--remove-label', name)
  for (const login of request.addAssignees) argv.push('--add-assignee', login)
  for (const login of request.removeAssignees) argv.push('--remove-assignee', login)

  return { ok: true, argv, addNames: add.names, removeNames: remove.names }
}
