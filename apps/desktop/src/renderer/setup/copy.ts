// Every string the Set up port checklist renders — pure, no DOM.
import type { SetupAction } from '@/types/setup'

export const SETUP_TITLE = 'Set up port'
export const SETUP_INTRO = 'port runs your own installed Claude Code and gh under your own accounts. Finish these steps to start.'
export const CLAUDE_STEP_LABEL = 'Claude Code installed and signed in'
export const GH_STEP_LABEL = 'gh installed and signed in'
export const REPO_STEP_LABEL = 'Add a repository'
export const SETUP_UNREACHABLE = "Couldn't reach the main process to check setup. Restart port to try again."
export const PROBE_UNREACHABLE = "Couldn't reach the main process to test the connection."
export const OPEN_BOARD = 'Open board'
export const SKIP_FOR_NOW = 'Skip for now'
export const FINISH_STEPS_FIRST = 'Finish the steps above first.'

export const PENDING_LABEL: Record<SetupAction['kind'], string> = {
  test: 'Testing…',
  'check-again': 'Checking…',
  'add-repository': 'Adding…',
}

export const CHECK_AGAIN = 'Check again'
export const TEST_SIGN_IN = 'Test sign-in'
export const ADD_REPOSITORY = 'Add repository'

export const COULDNT_CHECK = "Couldn't check"
export const FOUND = 'Found'
export const DONE = 'Done'
export const NEEDS_YOU = 'Needs you'

export const NOT_VERIFIED_YET = 'Not verified yet.'
export const GH_SIGNED_IN = 'Signed in to GitHub.'
export const GH_MISSING = "gh isn't installed. Install it from cli.github.com, then check again."
export const GH_SIGNED_OUT_PREFIX = 'gh is signed out. Run '
export const GH_LOGIN_COMMAND = 'gh auth login'
export const GH_SIGNED_OUT_SUFFIX = '.'
export const GH_UNKNOWN = "Couldn't check gh."
export const PICK_FOLDER = 'Pick a folder that holds a port-managed repository.'

export function verifiedBody(elapsedMs: number): string {
  return `Signed in · verified in ${(elapsedMs / 1000).toFixed(1)}s`
}

export function foundBody(version: string | null, path: string | null): string {
  if (version === null) return NOT_VERIFIED_YET
  return `Claude Code ${version}${path !== null ? ` · ${path}` : ''}. ${NOT_VERIFIED_YET}`
}

export function repoSummaryText(label: string, rest: number): string {
  return rest > 0 ? `${label} and ${String(rest)} more` : `${label} added`
}
