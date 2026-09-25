// The public surface #98 (and `main/ipc.ts`) import — never `./locate`,
// `./version`, `./credentials`, `./classify`, or `./sdk` directly. #98
// consumes `resolveClaudeExecutable` and `classifyProbeFailure` rather than
// re-deriving either (ENGINEERING §1).
export type { LocateResult, ResolveClaudeExecutableOptions } from './locate'
export { bundledSdkPackageDir, resolveClaudeExecutable } from './locate'

export type { ReadClaudeVersionOptions, ReadVersionResult } from './version'
export { readClaudeVersion } from './version'

export type { ReadCredentialsTellOptions } from './credentials'
export { readCredentialsTell } from './credentials'

export type { ClassifyPreflightInput, ClassifyProbeFailureInput } from './classify'
export { classifyPreflight, classifyProbeFailure } from './classify'

export type { ProbeOutcome, RunProbeParams, RuntimeProbeFn } from './sdk'
export { createRuntimeProbe } from './sdk'

export type { RunRuntimeProbeParams, RuntimePreflightDeps, RuntimeProbeDeps } from './preflight'
export { runtimePreflight, runtimeProbe } from './preflight'
