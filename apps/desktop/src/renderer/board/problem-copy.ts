// What a repository that is not ready says to the operator. Pure string functions; no DOM here.
import type { RepositoryState } from '@/types/state'
import type { RepoProblem } from '@/utils/repos'

export function repoProblemCopy(problem: RepoProblem): string {
  switch (problem.kind) {
    case 'directory-missing':
      return "That folder is gone. It may have moved, or be on a drive that isn't mounted."
    case 'not-a-git-repository':
      return "Not a git repository. Pick the repository's root folder."
    case 'not-port-managed':
      return problem.carriedBy.length > 0
        ? `Not port-managed on ${problem.ref}. ${problem.carriedBy.join(', ')} carry the harness — merge one into the default branch, then rescan.`
        : "Not port-managed. There's no .claude/port.config.json on any branch here."
    case 'config-ref-unreadable':
      return `Can't read the default branch at origin/HEAD — ${problem.message}.`
    case 'config-malformed':
      return `.claude/port.config.json isn't valid JSON — ${problem.message}.`
    case 'config-invalid':
      return `.claude/port.config.json has no usable repo: ${problem.violations[0]?.message ?? 'invalid'}.`
    case 'config-unreadable':
      return `Can't read .claude/port.config.json — ${problem.message}.`
    case 'effective-config-unreadable':
      return `Can't read ${problem.file} — ${problem.message}.`
  }
}

export function notReadyCopy(state: Extract<RepositoryState, { readonly ok: false }>): string {
  if (state.reason === 'not-ready') return repoProblemCopy(state.problem)
  return `Couldn't reach GitHub: ${state.message}. Retrying automatically.`
}
