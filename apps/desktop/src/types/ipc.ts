import type { RepoId, RepositoryEntry } from '@/utils/repos'
import type { ActionMap } from '@/main/app/router'

export type { ActionMap, ActionName, EventMap, EventName, MutationName, QueryName } from '@/main/app/router'

/** An action's request and response, read off its definition. */
export type ActionInput<N extends keyof ActionMap> = ActionMap[N]['input']
export type ActionOutput<N extends keyof ActionMap> = ActionMap[N]['output']

/** Every failure kind `readRegistry`/`writeRegistry` can report, shared by all three repository actions. */
export type RegistryFailureKind = 'registry-malformed' | 'registry-unsupported-version' | 'registry-unreadable' | 'registry-unwritable'

export type ReposListResponse =
  | { readonly ok: true; readonly repositories: readonly RepositoryEntry[] }
  | { readonly ok: false; readonly kind: RegistryFailureKind; readonly message: string }

export type ReposAddResponse =
  | { readonly ok: true; readonly outcome: 'added'; readonly added: RepoId; readonly repositories: readonly RepositoryEntry[] }
  | { readonly ok: true; readonly outcome: 'cancelled' }
  | { readonly ok: true; readonly outcome: 'already-registered'; readonly existing: RepoId; readonly repositories: readonly RepositoryEntry[] }
  | { readonly ok: false; readonly kind: RegistryFailureKind; readonly message: string }

export type ReposRemoveResponse =
  | { readonly ok: true; readonly repositories: readonly RepositoryEntry[] }
  | { readonly ok: false; readonly kind: 'not-registered' | 'registry-unwritable'; readonly message: string }
