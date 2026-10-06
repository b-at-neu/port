// The Set up port checklist's own `(preflight, probe, gh, repos) → display
// model` — the launch redirect reuses `complete` directly, so the two can never disagree.
import type { RuntimePreflight, RuntimeProbe } from '../../../shared/runtime/types'
import { RUNTIME_API_KEY_NOTE, RUNTIME_COPY } from '../../../shared/runtime/copy'
import { PILL_LABEL } from '../settings/runtime-model'
import type { GhStatus } from '../../../shared/gh/types'
import type { ReposListResponse } from '../../../shared/ipc'
import type { RepositoryEntry } from '../../../shared/repos'
import type { PillStatus } from '../components/status-pill'

/** One query's own loading/error/data split, kept loose for easy testing. */
export interface QueryState<T> {
  readonly status: 'pending' | 'error' | 'success'
  readonly data?: T
}

export type SetupStepState = 'loading' | 'done' | 'needs-you' | 'failed' | 'unreachable'

export interface SetupAction {
  readonly label: string
  readonly kind: 'test' | 'check-again' | 'add-repository'
}

export interface SetupStep {
  readonly state: SetupStepState
  readonly pillStatus: PillStatus
  readonly pillLabel: string
  readonly title: string
  readonly body: string
  readonly detail: string | null
  readonly action: SetupAction | null
}

export interface SetupModel {
  readonly claude: SetupStep
  readonly claudeApiKeyNote: string | null
  readonly gh: SetupStep
  readonly repo: SetupStep
  readonly complete: boolean
}

const LOADING_STEP: SetupStep = { state: 'loading', pillStatus: 'idle', pillLabel: '', title: '', body: '', detail: null, action: null }
const UNREACHABLE_ACTION: SetupAction = { label: 'Check again', kind: 'check-again' }

function unreachableStep(message: string): SetupStep {
  return { state: 'unreachable', pillStatus: 'danger', pillLabel: "Couldn't check", title: "Couldn't check", body: message, detail: null, action: UNREACHABLE_ACTION }
}

function claudeStep(preflight: QueryState<RuntimePreflight>, probe: RuntimeProbe | null): SetupStep {
  if (preflight.status === 'pending') return LOADING_STEP
  if (preflight.status === 'error' || preflight.data === undefined) {
    return unreachableStep("Couldn't reach the main process to check setup. Restart port to try again.")
  }

  const data = preflight.data
  const diagnosis = probe?.diagnosis ?? data.diagnosis

  if (diagnosis === 'verified' && probe !== null) {
    return {
      state: 'done',
      pillStatus: 'success',
      pillLabel: PILL_LABEL.verified,
      title: PILL_LABEL.verified,
      body: `Signed in · verified in ${(probe.elapsedMs / 1000).toFixed(1)}s`,
      detail: null,
      action: null,
    }
  }

  if (diagnosis === 'unverified') {
    const path = data.executable !== null ? data.executable.path : null
    const version = data.version?.raw ?? null
    const versionLine = version !== null ? `Claude Code ${version}${path !== null ? ` · ${path}` : ''}` : null
    return {
      state: 'done',
      pillStatus: 'success',
      pillLabel: 'Found',
      title: 'Found',
      body: versionLine !== null ? `${versionLine}. Not verified yet.` : 'Not verified yet.',
      detail: null,
      action: { label: 'Test sign-in', kind: 'test' },
    }
  }

  const copy = RUNTIME_COPY[diagnosis]
  const detail = probe?.detail ?? data.detail
  return {
    state: 'failed',
    pillStatus: 'danger',
    pillLabel: PILL_LABEL[diagnosis],
    title: copy.title,
    body: copy.body,
    detail,
    action: { label: 'Check again', kind: 'check-again' },
  }
}

function ghStep(gh: QueryState<GhStatus>): SetupStep {
  if (gh.status === 'pending') return LOADING_STEP
  if (gh.status === 'error' || gh.data === undefined) return unreachableStep("Couldn't reach the main process to check setup. Restart port to try again.")

  const status = gh.data
  if (status.kind === 'signed-in') {
    return { state: 'done', pillStatus: 'success', pillLabel: 'Done', title: 'Done', body: 'Signed in to GitHub.', detail: null, action: null }
  }
  if (status.kind === 'missing') {
    return {
      state: 'needs-you',
      pillStatus: 'attention',
      pillLabel: 'Needs you',
      title: 'Needs you',
      body: "gh isn't installed. Install it from cli.github.com, then check again.",
      detail: null,
      action: UNREACHABLE_ACTION,
    }
  }
  if (status.kind === 'signed-out') {
    return {
      state: 'needs-you',
      pillStatus: 'attention',
      pillLabel: 'Needs you',
      title: 'Needs you',
      body: 'gh is signed out. Run `gh auth login`.',
      detail: null,
      action: UNREACHABLE_ACTION,
    }
  }
  return { state: 'unreachable', pillStatus: 'danger', pillLabel: "Couldn't check", title: "Couldn't check", body: "Couldn't check gh.", detail: status.message, action: UNREACHABLE_ACTION }
}

function repoSummary(repositories: readonly RepositoryEntry[]): string {
  const first = repositories[0]
  if (first === undefined) return ''
  const label = 'config' in first ? first.config.repo : first.displayName
  const rest = repositories.length - 1
  return rest > 0 ? `${label} and ${String(rest)} more` : `${label} added`
}

function repoStep(repos: QueryState<ReposListResponse>): SetupStep {
  if (repos.status === 'pending') return LOADING_STEP
  if (repos.status === 'error' || repos.data === undefined || !repos.data.ok) {
    return unreachableStep("Couldn't reach the main process to check setup. Restart port to try again.")
  }

  if (repos.data.repositories.length === 0) {
    return {
      state: 'needs-you',
      pillStatus: 'attention',
      pillLabel: 'Needs you',
      title: 'Needs you',
      body: 'Pick a folder that holds a port-managed repository.',
      detail: null,
      action: { label: 'Add repository', kind: 'add-repository' },
    }
  }

  return { state: 'done', pillStatus: 'success', pillLabel: 'Done', title: 'Done', body: repoSummary(repos.data.repositories), detail: null, action: null }
}

/** `complete` is every step at `done` — a query in `error` is never `done`. */
export function setupModel(preflight: QueryState<RuntimePreflight>, probe: RuntimeProbe | null, gh: QueryState<GhStatus>, repos: QueryState<ReposListResponse>): SetupModel {
  const claude = claudeStep(preflight, probe)
  const ghResult = ghStep(gh)
  const repo = repoStep(repos)
  return {
    claude,
    claudeApiKeyNote: probe?.apiKeyInEnvironment ?? false ? RUNTIME_API_KEY_NOTE : null,
    gh: ghResult,
    repo,
    complete: claude.state === 'done' && ghResult.state === 'done' && repo.state === 'done',
  }
}
