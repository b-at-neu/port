// Settings' tab labels and the copy its cards share.
import type { SessionModel, SessionPermissionMode } from '@/types/hosting'
import type { SettingsSection } from '@/types/router'
import type { ThemePreference } from '@/types/theme'

export const SETTINGS_TITLE = 'Settings'

export const SECTION_LABEL: Readonly<Record<SettingsSection, string>> = {
  general: 'General',
  repositories: 'Repositories',
  connections: 'Connections',
  pipeline: 'Pipeline',
  usage: 'Usage & storage',
  audit: 'Audit log',
  incidents: 'Incidents',
  about: 'About',
}

/** A card that needs the width of two or three columns. */
export const WIDE_CARD = 'lg:col-span-2 2xl:col-span-3'

export const SETTINGS_GRID = 'grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3'

export function cardReadError(subject: string): string {
  return `Couldn't reach the main process to read ${subject}. Restart port to try again.`
}

export function cardCheckError(subject: string): string {
  return `Couldn't reach the main process to check ${subject}. Restart port to try again.`
}

export const SHORTCUT_SCOPE_LABEL = { global: 'Global', composer: 'Composer', list: 'Lists' } as const
export const SHORTCUTS_TITLE = 'Keyboard shortcuts'

export const RECHECK_LABEL = 'Recheck'
export const CHECKING_LABEL = 'Checking…'
export const TESTING_LABEL = 'Testing…'

export const SESSIONS_TITLE = 'Sessions'
export const SESSION_LIMIT_LABEL = 'Session limit'
export const SESSION_LIMIT_SUBJECT = 'the session limit'

export const NEW_SESSIONS_TITLE = 'New sessions'
export const NEW_SESSIONS_SUBJECT = 'session defaults'
export const MODEL_ROW_LABEL = 'Model'
export const MODE_ROW_LABEL = 'Permission mode'
export const NEW_SESSIONS_NOTE = 'Applies to sessions you start or restore from now on. Open sessions and pipeline agents keep their own settings.'

export const MODEL_LABEL: Readonly<Record<SessionModel | 'default', string>> = {
  default: 'Claude Code default',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
}

export const MODE_LABEL: Readonly<Record<SessionPermissionMode, string>> = {
  default: 'Ask before tools',
  acceptEdits: 'Accept edits',
  plan: 'Plan only',
}

export const MODE_HELPER: Readonly<Record<SessionPermissionMode, string>> = {
  default: 'Claude asks before any tool that isn’t already allowed.',
  acceptEdits: 'File edits apply without asking. Other tools still ask.',
  plan: 'Claude reads and plans, and changes nothing.',
}

export const PER_REPOSITORY_TITLE = 'Per repository'
export const PER_REPOSITORY_SUBJECT = 'repositories'
export const PER_REPOSITORY_EMPTY = 'Add a repository to see its pipeline settings.'
export const PER_REPOSITORY_NOTE = 'Set in the repository’s port.config.json, or by a port-overrides block in its CLAUDE.md.'
export const OPEN_REPOSITORY = 'Open repository'
export const ON_LABEL = 'On'
export const OFF_LABEL = 'Off'
export const CONFIG_ROW_LABEL = {
  plan: 'Plan model',
  impl: 'Implementation model',
  review: 'Review model',
  revise: 'Revision model',
  reviewCycleCap: 'Review cycle cap',
  approvalGate: 'Approval gate',
  budgetGate: 'Budget gate',
  concurrency: 'Concurrency threshold',
} as const

export const NOTIFICATIONS_TITLE = 'Notifications'
export const NOTIFICATIONS_SUBJECT = 'notification preferences'
export const NOTIFICATIONS_DESCRIPTION = 'Shown only while no port window is focused.'
export const NOTIFICATION_ROWS = {
  needsYou: 'When something needs you',
  sessions: 'When your own sessions finish or need permission',
} as const

export const APPEARANCE_TITLE = 'Appearance'
export const THEME_ROW_LABEL = 'Theme'
export const THEME_HELPER = 'System follows your operating system’s light or dark setting.'
export const THEME_LABEL: Readonly<Record<ThemePreference, string>> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
}

export const CLAUDE_CODE_TITLE = 'Claude Code'
export const CLAUDE_CODE_SUBJECT = 'Claude Code'
export const GH_TITLE = 'GitHub CLI'
export const GH_SUBJECT = 'gh'

export function checkedAgoLine(ago: string): string {
  return `Checked ${ago}`
}

export const GITHUB_API_TITLE = 'GitHub API'
export const GITHUB_API_NOTE = 'One gh login serves every repository, so one rate-limit reading is shared.'
export const REPOSITORY_READS_TITLE = 'Repository reads'
export const NO_REPOSITORY_READ = 'No repository has been read yet.'

export const SPEND_TITLE = 'Spend'
export const SPEND_SUBJECT = 'usage'
export const SPEND_EMPTY = 'No usage recorded yet. Totals appear after port hosts a session.'
export const SPEND_COLUMNS = ['Repository', 'Today', '7 days', '30 days'] as const
export const OTHER_FOLDERS = 'Other folders'
export const STORAGE_TITLE = 'Storage'
export const STORAGE_SUBJECT = 'storage'
export const RECALCULATE_LABEL = 'Recalculate'
export const CALCULATING_LABEL = 'Calculating…'
export const CLEAN_UP_LABEL = 'Clean up…'

export const ABOUT_TITLE = 'About'
export const APP_NAME = 'port'
export const VERSION_UNAVAILABLE = 'Version unavailable'
export const OPEN_SETUP_CHECKLIST = 'Open setup checklist'

export function versionLine(version: string): string {
  return `Version ${version}`
}

export function runtimeVersionsLine(electron: string, chromium: string, node: string): string {
  return `Electron ${electron} · Chromium ${chromium} · Node ${node}`
}
