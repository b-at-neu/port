// Settings' tab labels and the copy its cards share.
import type { SettingsSection } from '@/types/router'

export const SECTION_LABEL: Readonly<Record<SettingsSection, string>> = {
  general: 'General',
  repositories: 'Repositories',
  connections: 'Connections',
  pipeline: 'Pipeline',
  usage: 'Usage & storage',
  about: 'About',
}

/** A card that needs the width of two or three columns. */
export const WIDE_CARD = 'lg:col-span-2 2xl:col-span-3'

export const SETTINGS_GRID = 'grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3'

export function cardReadError(subject: string): string {
  return `Couldn't reach the main process to read ${subject}. Restart port to try again.`
}

export const SHORTCUT_SCOPE_LABEL = { global: 'Global', composer: 'Composer', list: 'Lists' } as const
