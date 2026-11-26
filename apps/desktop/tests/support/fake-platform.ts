// In-memory platform adapters. Anything not scripted throws, so a test fails loudly instead of reaching a host binary or the network.
import type { Platform } from '@/main/platform'
import type { SdkModule } from '@/main/platform/sdk'
import type { Clock, CommandResult, DirEntry, FileResult, GhResult, PlatformFs, PlatformUpdates, WhichResult } from '@/types/platform'
import type { FileDownloadRequest } from '@/types/update'

export interface FakeClock extends Clock {
  readonly advance: (ms: number) => void
}

export function createFakeClock(start: Date | string = '2026-01-01T00:00:00.000Z'): FakeClock {
  let current = new Date(start).getTime()
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms
    },
  }
}

const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')))

const withSlashes = (path: string): string => path.replace(/\\/g, '/')

/** Keys are stored with `/` so a fixture written through a native Windows path matches the code under test. */
export function createFakeFs(clock: Clock = createFakeClock()): PlatformFs {
  const raw = createSlashFs(clock)
  const wrapped: Record<string, unknown> = {}
  for (const [name, member] of Object.entries(raw)) {
    wrapped[name] = (first: unknown, ...rest: unknown[]) => (member as (...args: unknown[]) => unknown)(typeof first === 'string' ? withSlashes(first) : first, ...rest.map((arg) => (name === 'rename' && typeof arg === 'string' ? withSlashes(arg) : arg)))
  }
  return wrapped as unknown as PlatformFs
}

function createSlashFs(clock: Clock): PlatformFs {
  const files = new Map<string, string>()
  const dirs = new Set<string>()

  const isDir = (path: string): boolean => dirs.has(path) || [...files.keys(), ...dirs].some((key) => key.startsWith(`${path}/`))
  const ok = (): FileResult<void> => ({ ok: true, value: undefined })
  const missing = (path: string): { ok: false; kind: 'not-found'; message: string } => ({ ok: false, kind: 'not-found', message: `${path} does not exist` })

  function readText(path: string): Promise<FileResult<string>> {
    const text = files.get(path)
    if (text !== undefined) return Promise.resolve({ ok: true, value: text })
    if (isDir(path)) return Promise.resolve({ ok: false, kind: 'not-a-file', message: `${path} is a directory` })
    return Promise.resolve(missing(path))
  }

  return {
    readText,
    readJson: async <T>(path: string): Promise<FileResult<T>> => {
      const text = await readText(path)
      if (!text.ok) return text
      try {
        return { ok: true, value: JSON.parse(text.value) as T }
      } catch (error) {
        return { ok: false, kind: 'unparseable', message: error instanceof Error ? error.message : String(error) }
      }
    },
    writeJsonAtomic: (path, value) => {
      files.set(path, JSON.stringify(value, null, 2))
      return Promise.resolve(ok())
    },
    ensureDir: (path) => {
      dirs.add(path)
      return Promise.resolve(ok())
    },
    exists: (path) => Promise.resolve(files.has(path) || isDir(path)),
    writeText: (path, text) => {
      files.set(path, text)
      return Promise.resolve(ok())
    },
    appendText: (path, text) => {
      files.set(path, (files.get(path) ?? '') + text)
      return Promise.resolve(ok())
    },
    list: (path) => {
      if (!isDir(path)) return Promise.resolve(missing(path))
      const children = new Map<string, DirEntry>()
      for (const [key, kind] of [...[...files.keys()].map((file) => [file, 'file'] as const), ...[...dirs].map((dir) => [dir, 'directory'] as const)]) {
        if (!key.startsWith(`${path}/`)) continue
        const [name = '', ...rest] = key.slice(path.length + 1).split('/')
        children.set(name, { name, kind: rest.length > 0 ? 'directory' : kind })
      }
      return Promise.resolve({ ok: true, value: [...children.values()] })
    },
    stat: (path) => {
      const modifiedAt = clock.now().toISOString()
      const text = files.get(path)
      if (text !== undefined) return Promise.resolve({ ok: true, value: { kind: 'file', size: Buffer.byteLength(text), modifiedAt } })
      return Promise.resolve(isDir(path) ? { ok: true, value: { kind: 'directory', size: 0, modifiedAt } } : missing(path))
    },
    remove: (path) => Promise.resolve(files.delete(path) ? ok() : missing(path)),
    removeDirectory: (path) => {
      for (const key of [...files.keys()]) if (key.startsWith(`${path}/`)) files.delete(key)
      for (const key of [...dirs]) if (key === path || key.startsWith(`${path}/`)) dirs.delete(key)
      return Promise.resolve({ ok: true })
    },
    rename: (from, to) => {
      const text = files.get(from)
      if (text === undefined) return Promise.resolve(missing(from))
      files.delete(from)
      files.set(to, text)
      dirs.add(parentOf(to))
      return Promise.resolve(ok())
    },
    readLinesFrom: async (path, start, options) => {
      const text = await readText(path)
      if (!text.ok) return text
      const window = Buffer.from(text.value).subarray(start, start + options.maxBytes)
      const lastNewline = window.lastIndexOf(0x0a)
      const filledBudget = window.length === options.maxBytes
      if (lastNewline === -1) {
        if (filledBudget) return { ok: false, kind: 'too-large', message: `${path} has no newline within ${options.maxBytes} bytes of offset ${start}` }
        return { ok: true, value: { lines: [], bytesConsumed: 0, filledBudget } }
      }
      const lines = window.subarray(0, lastNewline).toString('utf8').split('\n')
      return { ok: true, value: { lines, bytesConsumed: lastNewline + 1, filledBudget } }
    },
  }
}

function unscripted(tool: string, args: readonly unknown[]): never {
  throw new Error(`unscripted ${tool} call: ${args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')}`)
}

export const fakeGh = (handler?: Platform['gh']): Platform['gh'] => handler ?? ((args) => unscripted('gh', args) as Promise<GhResult>)

export const fakeGit = (handler?: Platform['git']): Platform['git'] => handler ?? ((args, cwd) => unscripted('git', [...args, `(cwd ${cwd})`]) as Promise<CommandResult>)

export const fakeRun = (handler?: Platform['run']): Platform['run'] => handler ?? ((command, args) => unscripted(command, args) as Promise<CommandResult>)

export const fakeWhich = (handler?: Platform['which']): Platform['which'] => handler ?? ((command) => unscripted('which', [command]) as Promise<WhichResult>)

/** An `Sdk` whose unscripted members throw, so a test names only the calls its scenario makes. */
export function fakeSdk(module: Partial<SdkModule> = {}): Platform['sdk'] {
  const scripted: SdkModule = {
    query: (params) => unscripted('sdk.query', [JSON.stringify(params.options?.cwd ?? null)]),
    renameSession: (sessionId) => unscripted('sdk.renameSession', [sessionId]),
    listSessions: () => unscripted('sdk.listSessions', []),
    ...module,
  }
  return { load: () => Promise.resolve(scripted) }
}

export interface FakeUpdates extends PlatformUpdates {
  readonly opened: string[]
  readonly revealed: string[]
  readonly downloads: FileDownloadRequest[]
}

/** `Platform['updates']` whose unscripted members throw; opens, reveals and downloads are recorded. */
export function fakeUpdates(given: Partial<PlatformUpdates> = {}): FakeUpdates {
  const opened: string[] = []
  const revealed: string[] = []
  const downloads: FileDownloadRequest[] = []
  return {
    isPackaged: true,
    installHost: { platform: 'linux', arch: 'x64', appImage: undefined, arm64Translation: false },
    downloadsDir: () => unscripted('updates.downloadsDir', []),
    native: () => unscripted('updates.native', []),
    ...given,
    opened,
    revealed,
    downloads,
    download: (request) => {
      downloads.push(request)
      return given.download === undefined ? unscripted('updates.download', [request.url]) : given.download(request)
    },
    open: (path) => {
      opened.push(path)
      return given.open === undefined ? Promise.resolve('') : given.open(path)
    },
    reveal: (path) => {
      revealed.push(path)
      given.reveal?.(path)
    },
  }
}

export interface FakePlatform extends Platform {
  readonly clock: FakeClock
}

export function createFakePlatform(): FakePlatform {
  const clock = createFakeClock()
  return {
    gh: fakeGh(),
    ghWrite: fakeGh(),
    git: fakeGit(),
    run: fakeRun(),
    fs: createFakeFs(clock),
    sdk: { load: () => unscripted('sdk.load', []) },
    githubHttp: (request) => unscripted('githubHttp', [request.method, request.path]),
    githubConditional: (request) => unscripted('githubConditional', [request.method, request.path]),
    githubPublic: (request) => unscripted('githubPublic', [request.method, request.path]),
    clock,
    paths: { userData: '/test/userData', temp: '/test/temp', logs: '/test/logs' },
    info: () => ({ app: '0.0.0-test', electron: '0', node: '0', chromium: '0', commit: null }),
    dialogs: {
      chooseDirectory: () => unscripted('dialogs.chooseDirectory', []),
      chooseFolder: () => unscripted('dialogs.chooseFolder', []),
      chooseSavePath: (defaultName) => unscripted('dialogs.chooseSavePath', [defaultName]),
    },
    notify: { focused: () => unscripted('notify.focused', []), show: (notice) => unscripted('notify.show', [notice.title]) },
    which: fakeWhich(),
    env: {},
    claudeHome: '/test/claude',
    directorySize: (path) => unscripted('directorySize', [path]),
    updates: fakeUpdates(),
  }
}
