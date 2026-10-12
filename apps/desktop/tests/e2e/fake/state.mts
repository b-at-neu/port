// Typed scripted-state builders — the only way a flow writes fake-state.json.

export interface SandboxIssue {
  readonly number: number
  readonly title: string
  readonly state?: 'OPEN' | 'CLOSED'
  readonly labels: readonly string[]
  readonly assignees?: readonly string[]
  readonly body?: string
  readonly blockedBy?: ReadonlyArray<{ readonly number: number; readonly title: string; readonly url: string; readonly state: string }>
  readonly comments?: readonly string[]
}

export interface SandboxPull {
  readonly number: number
  readonly title: string
  readonly state?: 'OPEN' | 'CLOSED' | 'MERGED'
  readonly labels: readonly string[]
  readonly assignees?: readonly string[]
  readonly mergedAt?: string | null
  readonly headRefOid?: string
  readonly mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  readonly comments?: readonly string[]
}

export interface SandboxStateInput {
  readonly viewer: string
  readonly repo: string
  readonly gitBranch?: string
  readonly gitSha?: string
  readonly issues?: readonly SandboxIssue[]
  readonly pulls?: readonly SandboxPull[]
  readonly extraLabels?: readonly string[]
}

export interface SandboxState {
  readonly viewer: string
  readonly repo: string
  readonly gitBranch: string
  readonly gitSha: string
  issues: SandboxIssue[]
  pulls: SandboxPull[]
  readonly extraLabels: readonly string[]
}

/** The one builder every flow uses to seed `fake-state.json` — defaults fill in everything a
 *  flow does not care about, so a spec names only what its scenario actually needs. */
export function sandboxState(input: SandboxStateInput): SandboxState {
  return {
    viewer: input.viewer,
    repo: input.repo,
    gitBranch: input.gitBranch ?? 'dev',
    gitSha: input.gitSha ?? 'abc1234',
    issues: input.issues !== undefined ? input.issues.map((issue) => ({ ...issue })) : [],
    pulls: input.pulls !== undefined ? input.pulls.map((pull) => ({ ...pull })) : [],
    extraLabels: input.extraLabels ?? [],
  }
}
