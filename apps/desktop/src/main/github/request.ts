import type { GitHubRepoRef } from '@/types/github'
import type { GitHubRequest } from '@/types/platform'

/** Every variable is a string, the way `gh api -f` sent it. */
export function graphqlRequest(document: string, variables: Readonly<Record<string, string>>): GitHubRequest {
  return { method: 'POST', path: 'graphql', body: JSON.stringify({ query: document, variables }) }
}

export function repoGraphqlRequest(document: string, repo: GitHubRepoRef, extra: Readonly<Record<string, string>> = {}): GitHubRequest {
  return graphqlRequest(document, { owner: repo.owner, name: repo.name, ...extra })
}

export function restRequest(path: string, accept?: string): GitHubRequest {
  return accept === undefined ? { method: 'GET', path } : { method: 'GET', path, accept }
}

export const RAW_ACCEPT = 'application/vnd.github.raw'
