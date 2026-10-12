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

export interface RegistryDeps {
  readonly registryDir: string
  readonly git: GitRunner
  readonly chooseDirectory: () => Promise<string | null>
}
