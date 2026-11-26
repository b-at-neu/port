import { gh } from '@/main/platform/gh'
import { git } from '@/main/platform/git'
import { directorySize } from '@/main/platform/disk'
import { runCommand } from '@/main/platform/run'
import { defaultSdk, type Sdk } from '@/main/platform/sdk'
import { githubConditional, githubHttp, githubPublic } from '@/main/platform/github-http'
import {
  appendTextFile,
  ensureDirectory,
  listDirectory,
  pathExists,
  readJsonFile,
  readLinesFrom,
  readTextFile,
  removeDirectory,
  removeFile,
  renamePath,
  statPath,
  writeJsonFileAtomic,
  writeTextFile,
} from '@/main/platform/files'
import { pathOps } from '@/main/platform/paths'
import { which } from '@/main/platform/which'
import type { AppInfo } from '@/types/settings'
import type { Clock, CommandRunner, ConditionalTransport, DirectorySizeResult, GhRunner, GitHubTransport, GitRunner, NativeNotify, PlatformDialogs, PlatformFs, PlatformPaths, PlatformUpdates, WhichEnv, WhichResult } from '@/types/platform'
import type { InstallTargetInput } from '@/types/update'

/** Every host adapter, bound once; an action reaches I/O only through these. */
export interface Platform {
  readonly gh: GhRunner
  readonly ghWrite: GhRunner
  readonly git: GitRunner
  readonly run: CommandRunner
  readonly fs: PlatformFs
  readonly sdk: Sdk
  readonly githubHttp: GitHubTransport
  readonly githubConditional: ConditionalTransport
  readonly githubPublic: GitHubTransport
  readonly clock: Clock
  readonly paths: PlatformPaths
  readonly info: () => AppInfo
  readonly dialogs: PlatformDialogs
  readonly notify: NativeNotify
  readonly which: (command: string) => Promise<WhichResult>
  readonly env: WhichEnv
  readonly claudeHome: string
  readonly directorySize: (path: string) => Promise<DirectorySizeResult>
  readonly updates: PlatformUpdates
}

/** The Electron-bound facts, passed in by the composition root so this file imports no `electron`. */
export type PlatformHost = Pick<Platform, 'paths' | 'info' | 'dialogs' | 'notify' | 'updates'>

/** The one place `CLAUDE_CONFIG_DIR` is read. */
export function claudeHomeDir(): string {
  const fromEnv = process.env['CLAUDE_CONFIG_DIR']
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return pathOps.expandHome('~/.claude')
}

function unavailable(member: string): never {
  throw new Error(`${member} is not available without a window`)
}

/** The host for a thread with no window, such as the worker; its Electron-bound members throw. */
export function headlessHost(paths: PlatformPaths): PlatformHost {
  return {
    paths,
    info: () => unavailable('info'),
    dialogs: {
      chooseDirectory: () => unavailable('dialogs.chooseDirectory'),
      chooseFolder: () => unavailable('dialogs.chooseFolder'),
      chooseSavePath: () => unavailable('dialogs.chooseSavePath'),
    },
    notify: {
      focused: () => unavailable('notify.focused'),
      show: () => unavailable('notify.show'),
    },
    updates: {
      get isPackaged(): boolean {
        return unavailable('updates.isPackaged')
      },
      get installHost(): InstallTargetInput {
        return unavailable('updates.installHost')
      },
      downloadsDir: () => unavailable('updates.downloadsDir'),
      download: () => unavailable('updates.download'),
      open: () => unavailable('updates.open'),
      reveal: () => unavailable('updates.reveal'),
      native: () => unavailable('updates.native'),
    },
  }
}

export const hostFs: PlatformFs = {
  readJson: readJsonFile,
  writeJsonAtomic: writeJsonFileAtomic,
  ensureDir: ensureDirectory,
  exists: pathExists,
  readText: readTextFile,
  writeText: writeTextFile,
  appendText: appendTextFile,
  list: listDirectory,
  stat: statPath,
  remove: removeFile,
  removeDirectory,
  rename: renamePath,
  readLinesFrom,
}

export function createPlatform(host: PlatformHost): Platform {
  return {
    gh,
    ghWrite: gh,
    git: (args, cwd) => git(args, { cwd }),
    run: runCommand,
    fs: hostFs,
    sdk: defaultSdk,
    githubHttp,
    githubConditional,
    githubPublic,
    clock: { now: () => new Date() },
    which: (command) => which({ command, env: process.env, platform: process.platform }),
    env: process.env,
    claudeHome: claudeHomeDir(),
    directorySize: (path) => directorySize(path),
    ...host,
  }
}
