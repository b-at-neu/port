import type { GitRunner } from '@/types/platform'


/** Values `inspect.ts` has already defaulted off the schema, before any `CLAUDE.md` override applies. */
export interface PortResolved {
  readonly branches: { readonly integration: string; readonly production: string | null }
  readonly models: { readonly plan: string; readonly impl: string; readonly review: string; readonly revise: string }
  readonly modules: { readonly approvalGate: boolean; readonly release: boolean; readonly scope: boolean }
  readonly reviewCycleCap: number
  readonly concurrency: { readonly sharedFiles: readonly string[]; readonly overlapThreshold: number }
  /** Seeds `sessionRequiredPaths +=` — nothing else in the app consumes the resolved list. */
  readonly sessionRequiredPaths: readonly string[]
}

/** A file read from the repository's default branch at `origin/HEAD`, the ref stage agents read. */
export type RefRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly kind: 'ref-unreadable' | 'not-found' | 'unreadable'; readonly message: string }

export type RefReader = (relPath: string) => Promise<RefRead>

export interface RegistryDeps {
  readonly registryDir: string
  readonly git: GitRunner
  readonly chooseDirectory: () => Promise<string | null>
}
