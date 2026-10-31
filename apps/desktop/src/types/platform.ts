export type ClaudeOptions = Omit<RunCommandOptions, 'whichEnv' | 'platform'>

export type ReadLinesFromResult = FileResult<ReadLinesFromValue>

export interface ReadLinesFromValue {
  readonly lines: readonly string[]
  /** The caller's next `start`. A partial trailing line is never counted here, so a resumed read picks it up whole. */
  readonly bytesConsumed: number
  /** The only honest "there may be more past this window" signal; `nextOffset < size` is not one. */
  readonly filledBudget: boolean
}

export type DirEntryKind = 'file' | 'directory' | 'symlink' | 'other'

export interface DirEntry {
  readonly name: string
  readonly kind: DirEntryKind
}

export type FileResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly kind: FileFailureKind; readonly message: string }

/** ENOENT is a value, never an exception — callers must distinguish "no config" from "unreadable". */
export type FileFailureKind = 'not-found' | 'not-a-file' | 'permission-denied' | 'too-large' | 'unparseable' | 'io'

export type GhOptions = Omit<RunCommandOptions, 'whichEnv' | 'platform'>

export type GhClassification = 'unauthenticated' | 'rate-limited' | 'forbidden' | 'http-not-found' | 'network' | 'unknown'

/** An injectable `gh` invocation, so a test runs against a fake runner and needs no real `gh` binary. */
export type GhRunner = (args: readonly string[], options?: GhOptions) => Promise<GhResult>

export type GhAuthStatusResult = { readonly ok: true; readonly authenticated: boolean } | Exclude<GhResult, { ok: true } | { ok: false; kind: 'unauthenticated' }>

export type GhResult =
  | { readonly ok: true; readonly stdout: string; readonly stderr: string }
  | Exclude<CommandResult, { ok: true } | { ok: false; kind: 'nonzero' }>
  | { readonly ok: false; readonly kind: GhClassification; readonly stdout: string; readonly stderr: string }

export type GitRunner = (args: readonly string[], cwd: string) => Promise<CommandResult>

export type GitLinesResult = { readonly ok: true; readonly lines: readonly string[] } | Exclude<CommandResult, { ok: true }>

export type NodeOptions = Omit<RunCommandOptions, 'whichEnv' | 'platform'>

export type NodeRunner = (args: readonly string[], options: NodeOptions) => Promise<CommandResult>

export type PathFlavour = 'posix' | 'win32'

declare const repoKeyBrand: unique symbol

/** Branded so a plain string path can never be passed where a normalised key is expected. */
export type RepoKey = string & { readonly [repoKeyBrand]: true }

export interface PathOps {
  readonly flavour: PathFlavour
  toNative(p: string): string
  toPosix(p: string): string
  pathKey(p: string): RepoKey
  samePath(a: string, b: string): boolean
  contains(parent: string, child: string): boolean
  expandHome(p: string): string
  resolveFrom(base: string, p: string): string
  join(base: string, ...segments: string[]): string
  dirname(p: string): string
  basename(p: string): string
}

/** A literal union, so an adapter reaching for a POSIX-only utility is a compile-time error. */
export type KnownCommand = 'git' | 'gh' | 'node' | 'claude'

interface SpawnOutcome {
  readonly stdout: string
  readonly stderr: string
}

interface SpawnParams {
  readonly cwd: string | undefined
  readonly timeout: number
  readonly maxBuffer: number
  readonly env: NodeJS.ProcessEnv
}

/** Rejects with a plain, duck-typed failure, so a fake spawner in a test needs no real
 *  spawn-error shape. */
export type Spawner = (absPath: string, args: readonly string[], params: SpawnParams) => Promise<SpawnOutcome>

export interface RunExecutableOptions {
  readonly cwd?: string
  readonly timeoutMs?: number
  readonly maxBytes?: number
  readonly env?: NodeJS.ProcessEnv
  readonly spawner?: Spawner
}

export interface RunCommandOptions extends RunExecutableOptions {
  readonly whichEnv?: WhichEnv
  readonly platform?: NodeJS.Platform
  readonly resolve?: (options: { command: KnownCommand; env: WhichEnv; platform: NodeJS.Platform }) => Promise<WhichResult>
}

// One error rule, everywhere: a condition a human could cause is a value; a programmer mistake is a throw.
export type CommandResult =
  | { readonly ok: true; readonly stdout: string; readonly stderr: string }
  | { readonly ok: false; readonly kind: 'not-found'; readonly command: string; readonly searched: readonly string[] }
  | { readonly ok: false; readonly kind: 'cwd-missing'; readonly cwd: string }
  | { readonly ok: false; readonly kind: 'nonzero'; readonly code: number; readonly stdout: string; readonly stderr: string }
  | { readonly ok: false; readonly kind: 'signalled'; readonly signal: string; readonly stderr: string }
  | { readonly ok: false; readonly kind: 'timeout'; readonly timeoutMs: number; readonly stderr: string }
  | { readonly ok: false; readonly kind: 'output-too-large'; readonly maxBytes: number }
  | { readonly ok: false; readonly kind: 'spawn-failed'; readonly message: string }

export type WhichResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly kind: 'not-found'; readonly command: string; readonly searched: readonly string[] }

export interface WhichOptions {
  readonly command: string
  readonly env: WhichEnv
  readonly platform: NodeJS.Platform
  /** Injectable existence/executable probe — real filesystem access by
   *  default, a stub in tests so no binary needs to actually be installed. */
  readonly probe?: (candidate: string) => Promise<boolean>
}

export interface WhichEnv {
  readonly PATH?: string
  readonly PATHEXT?: string
  readonly [key: string]: string | undefined
}
