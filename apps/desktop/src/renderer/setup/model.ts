// The Set up port checklist's own `(preflight, probe, gh, repos) → display
// model` — the launch redirect reuses `complete` directly, so the two can never disagree.
import type { RuntimePreflight, RuntimeProbe } from '@/types/runtime'
import { RUNTIME_API_KEY_NOTE, RUNTIME_COPY } from '@/renderer/runtime/copy'
import { PILL_LABEL } from '@/renderer/settings/runtime-model'
import type { GhStatus } from '@/types/gh'
import type { ReposListResponse } from '@/types/ipc'
import type { RepositoryEntry } from '@/utils/repos'
import type { QueryState, SetupAction, SetupStep } from '@/types/setup'
import {
  ADD_REPOSITORY,
  CHECK_AGAIN,
  COULDNT_CHECK,
  DONE,
  FOUND,
  foundBody,
  GH_LOGIN_COMMAND,
  GH_MISSING,
  GH_SIGNED_IN,
  GH_SIGNED_OUT_PREFIX,
  GH_SIGNED_OUT_SUFFIX,
  GH_UNKNOWN,
  NEEDS_YOU,
  PICK_FOLDER,
  repoSummaryText,
  SETUP_UNREACHABLE,
  TEST_SIGN_IN,
  verifiedBody,
} from '@/renderer/setup/copy'

interface SetupModel {
  readonly claude: SetupStep
  readonly claudeApiKeyNote: string | null
  readonly gh: SetupStep
  readonly repo: SetupStep
  readonly complete: boolean
}

const LOADING_STEP: SetupStep = { state: 'loading', pillStatus: 'idle', pillLabel: '', title: '', body: '', bodyCommand: null, bodySuffix: '', detail: null, action: null }
const UNREACHABLE_ACTION: SetupAction = { label: CHECK_AGAIN, kind: 'check-again' }

function unreachableStep(message: string): SetupStep {
  return { state: 'unreachable', pillStatus: 'danger', pillLabel: COULDNT_CHECK, title: COULDNT_CHECK, body: message, bodyCommand: null, bodySuffix: '', detail: null, action: UNREACHABLE_ACTION }
}

function claudeStep(preflight: QueryState<RuntimePreflight>, probe: RuntimeProbe | null): SetupStep {
  if (preflight.status === 'pending') return LOADING_STEP
  if (preflight.status === 'error' || preflight.data === undefined) {
    return unreachableStep(SETUP_UNREACHABLE)
  }

  const data = preflight.data
  const diagnosis = probe?.diagnosis ?? data.diagnosis

  if (diagnosis === 'verified' && probe !== null) {
    return {
      state: 'done',
      pillStatus: 'success',
      pillLabel: PILL_LABEL.verified,
      title: PILL_LABEL.verified,
      body: verifiedBody(probe.elapsedMs),
      bodyCommand: null,
      bodySuffix: '',
      detail: null,
      action: null,
    }
  }

  if (diagnosis === 'unverified') {
    return {
      state: 'done',
      pillStatus: 'success',
      pillLabel: FOUND,
      title: FOUND,
      body: foundBody(data.version?.raw ?? null, data.executable !== null ? data.executable.path : null),
      bodyCommand: null,
      bodySuffix: '',
      detail: null,
      action: { label: TEST_SIGN_IN, kind: 'test' },
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
    bodyCommand: null,
    bodySuffix: '',
    detail,
    action: UNREACHABLE_ACTION,
  }
}

function needsYouStep(body: string, bodyCommand: string | null, bodySuffix: string, action: SetupAction): SetupStep {
  return { state: 'needs-you', pillStatus: 'attention', pillLabel: NEEDS_YOU, title: NEEDS_YOU, body, bodyCommand, bodySuffix, detail: null, action }
}

function doneStep(body: string): SetupStep {
  return { state: 'done', pillStatus: 'success', pillLabel: DONE, title: DONE, body, bodyCommand: null, bodySuffix: '', detail: null, action: null }
}

function ghStep(gh: QueryState<GhStatus>): SetupStep {
  if (gh.status === 'pending') return LOADING_STEP
  if (gh.status === 'error' || gh.data === undefined) return unreachableStep(SETUP_UNREACHABLE)

  const status = gh.data
  if (status.kind === 'signed-in') return doneStep(GH_SIGNED_IN)
  if (status.kind === 'missing') return needsYouStep(GH_MISSING, null, '', UNREACHABLE_ACTION)
  if (status.kind === 'signed-out') return needsYouStep(GH_SIGNED_OUT_PREFIX, GH_LOGIN_COMMAND, GH_SIGNED_OUT_SUFFIX, UNREACHABLE_ACTION)
  return { state: 'unreachable', pillStatus: 'danger', pillLabel: COULDNT_CHECK, title: COULDNT_CHECK, body: GH_UNKNOWN, bodyCommand: null, bodySuffix: '', detail: status.message, action: UNREACHABLE_ACTION }
}

function repoSummary(repositories: readonly RepositoryEntry[]): string {
  const first = repositories[0]
  if (first === undefined) return ''
  return repoSummaryText('config' in first ? first.config.repo : first.displayName, repositories.length - 1)
}

function repoStep(repos: QueryState<ReposListResponse>): SetupStep {
  if (repos.status === 'pending') return LOADING_STEP
  if (repos.status === 'error' || repos.data === undefined || !repos.data.ok) {
    return unreachableStep(SETUP_UNREACHABLE)
  }

  if (repos.data.repositories.length === 0) return needsYouStep(PICK_FOLDER, null, '', { label: ADD_REPOSITORY, kind: 'add-repository' })

  return doneStep(repoSummary(repos.data.repositories))
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
