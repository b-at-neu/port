import { gh } from '@/main/platform/gh'
import { git } from '@/main/platform/git'
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
import type { AppInfo } from '@/types/settings'
import type { Clock, CommandRunner, ConditionalTransport, GhRunner, GitHubTransport, GitRunner, NativeNotify, PlatformDialogs, PlatformFs, PlatformPaths } from '@/types/platform'

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
}

/** The Electron-bound facts, passed in by the composition root so this file imports no `electron`. */
export type PlatformHost = Pick<Platform, 'paths' | 'info' | 'dialogs' | 'notify'>

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
    ...host,
  }
}
