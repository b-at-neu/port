export const UNDO_LABEL = 'Undo'

export const SHOW_ALL_REPOSITORIES = 'Show all repositories'

export const ALL_REPOSITORIES = 'All repositories'

export const SEARCH_ACTION = 'Search'

export const OPEN_REPOSITORIES = 'Open Repositories'

export function releasesNotReadyCopy(repo: string): string {
  return `${repo} isn't ready, so its releases aren't listed. Fix it on Repositories.`
}

/** A repo-scoped screen was opened with a `repo` that no registered repository has. */
export function unknownRepoCopy(repo: string): string {
  return `${repo} isn't a registered repository.`
}
