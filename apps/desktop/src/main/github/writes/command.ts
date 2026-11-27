// The only file in the app allowed to name `--add-label`/`--remove-label`. Pure: no `gh`, no filesystem.

interface BuildCommandParams {
  readonly kind: 'issue' | 'pull-request'
  readonly number: number
  readonly repo: string
  readonly addNames: readonly string[]
  readonly removeNames: readonly string[]
  readonly addAssignees: readonly string[]
  readonly removeAssignees: readonly string[]
}

// Never `merge`, `close`, `--delete-branch`, or `ready`, which stay human actions on GitHub.
export function buildCommand(params: BuildCommandParams): readonly string[] {
  const subcommand = params.kind === 'pull-request' ? 'pr' : 'issue'
  const argv: string[] = [subcommand, 'edit', String(params.number), '--repo', params.repo]
  for (const name of params.addNames) argv.push('--add-label', name)
  for (const name of params.removeNames) argv.push('--remove-label', name)
  for (const login of params.addAssignees) argv.push('--add-assignee', login)
  for (const login of params.removeAssignees) argv.push('--remove-assignee', login)
  return argv
}
