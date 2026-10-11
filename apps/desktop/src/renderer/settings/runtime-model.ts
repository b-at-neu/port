// The Settings screen's Claude Code section (#316) — pure
// `(preflight, probe, readyRepo, probeError) → display model`, so
// `screen.tsx`/`runtime-section.tsx` only ever render what this function
// returns, and every UX-state decision is unit-tested here rather than in a
// component. Shares `shared/runtime/copy.ts`'s copy table rather than
// redeclaring any of it.
import type { RuntimeDiagnosis, RuntimePreflight, RuntimeProbe } from '../../../shared/runtime/types'
import { CLI_OUTDATED_COPY, RUNTIME_API_KEY_NOTE, RUNTIME_COPY, RUNTIME_NO_READY_REPO_NOTE, RUNTIME_PROBE_ERROR, runtimeActionLabel } from '../../../shared/runtime/copy'
import type { PillStatus } from '../components/status-pill'

export interface ReadyRepo {
  readonly id: string
  readonly repo: string
}

export interface RuntimeAction {
  readonly label: string
  readonly kind: 'test' | 'retry'
  readonly disabledReason: string | null
}

export interface RuntimeDiagnosisModel {
  readonly pillStatus: PillStatus
  readonly pillLabel: string
  /** `"Claude Code 2.1.3 · /path/to/claude"` — omitted when nothing resolved. */
  readonly versionLine: string | null
  readonly title: string
  readonly body: string
  readonly detail: string | null
  readonly notes: readonly string[]
  readonly action: RuntimeAction | null
  /** The probe's own invoke-rejected case — a distinct field, not folded
   *  into `notes`, since the UX spec renders it as its own `ErrorBanner`
   *  rather than a muted note line. */
  readonly probeErrorMessage: string | null
}

/** DESIGN §2's own pill vocabulary: `Verified` (success), `Not verified`
 *  (idle), and every other diagnosis `danger` — matching the red footer dot
 *  the runtime strip already uses for the same failures. */
const PILL_STATUS: Readonly<Record<RuntimeDiagnosis, PillStatus>> = {
  unverified: 'idle',
  verified: 'success',
  'cli-missing': 'danger',
  'bundled-fallback': 'danger',
  'cli-unusable': 'danger',
  unauthenticated: 'danger',
  'token-stale': 'danger',
  'policy-refused': 'danger',
  'probe-failed': 'danger',
}

export const PILL_LABEL: Readonly<Record<RuntimeDiagnosis, string>> = {
  unverified: 'Not verified',
  verified: 'Verified',
  'cli-missing': 'Not installed',
  'bundled-fallback': 'Wrong binary',
  'cli-unusable': 'Not working',
  unauthenticated: 'Signed out',
  'token-stale': 'Login expired',
  'policy-refused': 'Not permitted',
  'probe-failed': 'Test failed',
}

function versionLineFor(preflight: RuntimePreflight): string | null {
  if (preflight.version === null || preflight.version.raw === null) return null
  const path = preflight.executable !== null ? ` · ${preflight.executable.path}` : ''
  return `Claude Code ${preflight.version.raw}${path}`
}

export function runtimeDiagnosisModel(
  preflight: RuntimePreflight,
  probe: RuntimeProbe | null,
  readyRepo: ReadyRepo | null,
  probeError: boolean,
  reposPending = false,
): RuntimeDiagnosisModel {
  const diagnosis = probe?.diagnosis ?? preflight.diagnosis
  const detail = probe?.detail ?? preflight.detail

  let title: string
  let body: string
  if (diagnosis === 'unverified') {
    title = PILL_LABEL.unverified
    body = 'A test runs one short turn against a registered repository.'
  } else if (diagnosis === 'verified' && probe !== null) {
    title = PILL_LABEL.verified
    body = probe.repo !== null ? `Verified against ${probe.repo} in ${(probe.elapsedMs / 1000).toFixed(1)}s` : `Verified in ${(probe.elapsedMs / 1000).toFixed(1)}s`
  } else {
    const copy = RUNTIME_COPY[diagnosis]
    title = copy.title
    body = copy.body
  }

  const notes: string[] = []
  if (probe?.apiKeyInEnvironment ?? false) notes.push(RUNTIME_API_KEY_NOTE)
  if (preflight.version?.belowMinimum ?? false) notes.push(CLI_OUTDATED_COPY.title)

  const label = runtimeActionLabel(diagnosis)
  // `repos:list` resolving after `runtime:preflight` is a real race — a
  // still-pending repos query is not evidence of "no ready repo", so
  // withhold the action entirely rather than flashing the disabled-with-
  // reason state for a repo that is actually registered.
  const action: RuntimeAction | null =
    label === null || (diagnosis === 'unverified' && readyRepo === null && reposPending)
      ? null
      : {
          label,
          kind: diagnosis === 'unverified' ? 'test' : 'retry',
          // Only 'Test connection' needs a ready repository — every other
          // diagnosis's 'Retry' just re-runs the cheap preflight.
          disabledReason: diagnosis === 'unverified' && readyRepo === null ? RUNTIME_NO_READY_REPO_NOTE : null,
        }

  return {
    pillStatus: PILL_STATUS[diagnosis],
    pillLabel: PILL_LABEL[diagnosis],
    versionLine: versionLineFor(preflight),
    title,
    body,
    detail,
    notes,
    action,
    probeErrorMessage: probeError ? RUNTIME_PROBE_ERROR : null,
  }
}
