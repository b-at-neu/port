export type ClaudeOptions = Omit<RunCommandOptions, 'whichEnv' | 'platform'>

export type ReadLinesFromResult = FileResult<ReadLinesFromValue>

export interface ReadLinesFromValue {
  readonly lines: readonly string[]
  /** The caller's next `start`. A partial trailing line is never counted here, so a resumed read picks it up whole. */
  readonly bytesConsumed: number
  /** The only honest "there may be more past this window" signal; `nextOffset < size` is not one. */
  readonly filledBudget: boolean
}

export interface ReadLinesFromOptions {
  readonly maxBytes: number
}

export type DirEntryKind = 'file' | 'directory' | 'symlink' | 'other'

export interface DirEntry {
  readonly name: string
  readonly kind: DirEntryKind
}

export interface StatInfo {
  readonly kind: 'file' | 'directory' | 'other'
  readonly size: number
  readonly modifiedAt: string
}

/** `code` is the errno string (`EBUSY`), kept so a caller can tell a held file from a long path. */
export type RemoveDirectoryResult = { readonly ok: true } | { readonly ok: false; readonly code: string | null; readonly message: string }

export type FileResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly kind: FileFailureKind; readonly message: string }

/** ENOENT is a value, never an exception — callers must distinguish "no config" from "unreadable". */
export type FileFailureKind = 'not-found' | 'not-a-file' | 'permission-denied' | 'too-large' | 'unparseable' | 'io'

export type GhOptions = Omit<RunCommandOptions, 'whichEnv' | 'platform'>

export type GhClassification = 'unauthenticated' | 'rate-limited' | 'forbidden' | 'http-not-found' | 'network' | 'unknown'

/** An injectable `gh` invocation, so a test runs against a fake runner and needs no real `gh` binary. */
export type GhRunner = (args: readonly string[], options?: GhOptions) => Promise<GhResult>

/** `output` is stdout then stderr, since older gh releases print the status on stderr. */
export type GhAuthStatusResult = { readonly ok: true; readonly authenticated: boolean; readonly output: string } | Exclude<GhResult, { ok: true } | { ok: false; kind: 'unauthenticated' }>

export type GhResult =
  | { readonly ok: true; readonly stdout: string; readonly stderr: string }
  | Exclude<CommandResult, { ok: true } | { ok: false; kind: 'nonzero' }>
  | { readonly ok: false; readonly kind: GhClassification; readonly stdout: string; readonly stderr: string }

export interface GitHubRequest {
  readonly method: 'GET' | 'POST'
  /** `graphql` or `repos/…`, joined onto the API base. */
  readonly path: string
  readonly accept?: string
  /** JSON text, POST only. */
  readonly body?: string
}

export type GitHubHttpResult =
  | { readonly ok: true; readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: string }
  | Exclude<CommandResult, { ok: true } | { ok: false; kind: 'nonzero' }>
  | { readonly ok: false; readonly kind: GhClassification; readonly status: number | null; readonly body: string; readonly message: string }

/** Injectable, so a test runs against a fake and needs no network or token. */
export type GitHubTransport = (request: GitHubRequest) => Promise<GitHubHttpResult>

export interface ConditionalRequest {
  readonly method: 'GET'
  readonly path: string
  readonly accept?: string
  /** Sent verbatim as `If-None-Match`; absent → an unconditional GET. */
  readonly ifNoneMatch?: string
}

/** A 304 is a success here — `notModified` is the discriminant, and only a request that sent a validator can produce one. */
export type ConditionalHttpResult =
  | { readonly ok: true; readonly notModified: false; readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: string }
  | { readonly ok: true; readonly notModified: true; readonly status: 304; readonly headers: Readonly<Record<string, string>> }
  | Exclude<GitHubHttpResult, { ok: true }>

export type ConditionalTransport = (request: ConditionalRequest) => Promise<ConditionalHttpResult>

export type DirectorySizeResult =
  | { readonly ok: true; readonly bytes: number; readonly entries: number; readonly truncated: boolean }
  | { readonly ok: false; readonly kind: 'not-found' | 'io'; readonly message: string }

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

/** Main's one clock; a caller that needs milliseconds calls `now().getTime()`. */
export interface Clock {
  readonly now: () => Date
}

export type CommandRunner = (command: KnownCommand, args: readonly string[], options?: RunCommandOptions) => Promise<CommandResult>

/** Member names match `StoreFs`, so `createJsonStore({ fs: ctx.fs })` needs no adapter. */
export interface PlatformFs {
  readonly readJson: <T = unknown>(path: string) => Promise<FileResult<T>>
  readonly writeJsonAtomic: (path: string, value: unknown) => Promise<FileResult<void>>
  readonly ensureDir: (path: string) => Promise<FileResult<void>>
  readonly exists: (path: string) => Promise<boolean>
  readonly readText: (path: string) => Promise<FileResult<string>>
  readonly writeText: (path: string, text: string) => Promise<FileResult<void>>
  readonly appendText: (path: string, text: string) => Promise<FileResult<void>>
  readonly list: (path: string) => Promise<FileResult<readonly DirEntry[]>>
  readonly stat: (path: string) => Promise<FileResult<StatInfo>>
  readonly remove: (path: string) => Promise<FileResult<void>>
  readonly removeDirectory: (path: string) => Promise<RemoveDirectoryResult>
  readonly rename: (from: string, to: string) => Promise<FileResult<void>>
  readonly readLinesFrom: (path: string, start: number, options: ReadLinesFromOptions) => Promise<ReadLinesFromResult>
}

export interface PlatformPaths {
  readonly userData: string
  readonly temp: string
  readonly logs: string
}

export interface PlatformDialogs {
  readonly chooseDirectory: () => Promise<string | null>
  readonly chooseFolder: () => Promise<string | null>
  readonly chooseSavePath: (defaultName: string) => Promise<string | null>
}

export interface NativeNotify {
  readonly focused: () => boolean
  readonly show: (notice: { readonly title: string; readonly body: string }, onClick: () => void) => void
}

/** The three GitHub transports one client carries; the host's reads GitHub, the E2E build's reads the fake. */
export interface GitHubClient {
  readonly request: GitHubTransport
  readonly conditional: ConditionalTransport
  readonly public: GitHubTransport
}

/** What `runCommand` executes, or the failure that stops it before a spawn. */
export type ResolvedCommand = { readonly ok: true; readonly path: string; readonly args: readonly string[]; readonly env: NodeJS.ProcessEnv | undefined } | Extract<CommandResult, { readonly ok: false }>

/** The one seam between the app and the host: the E2E build swaps it for a route that never reaches a host binary or the network. */
export interface PlatformRoute {
  resolveCommand(command: KnownCommand, args: readonly string[], options: RunCommandOptions): Promise<ResolvedCommand>
  githubClient(real: GitHubClient, run: (command: KnownCommand, args: readonly string[]) => Promise<CommandResult>): GitHubClient
}

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
