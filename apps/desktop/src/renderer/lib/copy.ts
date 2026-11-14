export const UNDO_LABEL = 'Undo'

export const SHOW_ALL_REPOSITORIES = 'Show all repositories'

export function releasesNotReadyCopy(repo: string): string {
  return `${repo} isn't ready, so its releases aren't listed. Fix it on Repositories.`
}

/** A repo-scoped screen was opened with a `repo` that no registered repository has. */
export function unknownRepoCopy(repo: string): string {
  return `${repo} isn't a registered repository.`
}
