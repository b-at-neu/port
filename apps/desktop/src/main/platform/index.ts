// The single place the app spawns a subprocess, touches the filesystem, or
// manipulates a path string. Every adapter under apps/desktop/src/ imports
// from here — never a subprocess or filesystem module directly. The
// `desktop-platform-layer` check in scripts/checks.mjs pins this
// mechanically: `run.ts` is the only file in this tree allowed to spawn a
// subprocess, and no filesystem import exists outside this directory.
export type { PathFlavour, PathOps, PathOpsOptions, RepoKey } from './paths'
export { createPathOps, pathOps } from './paths'

export type { WhichEnv, WhichOptions, WhichPlatform, WhichResult } from './which'
export { createWhich, which } from './which'

export type { CommandResult, KnownCommand, RunCommandOptions, Spawner, SpawnOutcome, SpawnParams } from './run'
export { KNOWN_COMMANDS, runCommand } from './run'

export type { GitLinesResult, GitOptions, GitRepoRootResult } from './git'
export { git, gitLines, gitRepoRoot, parsePorcelainStanzas, splitNul } from './git'

export type { GhAuthStatusResult, GhClassification, GhExitOutcome, GhJsonResult, GhOptions, GhResult } from './gh'
export { classifyGhExit, gh, ghAuthStatus, ghJson } from './gh'

export type { DirEntry, DirEntryKind, FileFailureKind, FileResult, StatInfo } from './files'
export { listDirectory, readJsonFile, readTextFile, statPath } from './files'
