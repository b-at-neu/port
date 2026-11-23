import { readJsonFile } from '@/main/platform/files'
import { pathOps } from '@/main/platform/paths'
import type { FileResult } from '@/types/platform'

interface SettingsShape {
  readonly permissions?: { readonly allow?: unknown }
}

const EDIT_RULE = /^(?:Edit|Write|MultiEdit|NotebookEdit)(?:\((.*)\))?$/

/** Narrows `permissions.allow` to repository-relative edit globs; any rule shape it does not recognise is dropped, which leaves the deny in place. */
export function editAllowGlobs(rules: unknown): readonly string[] {
  if (!Array.isArray(rules)) return []
  const globs: string[] = []
  for (const rule of rules) {
    if (typeof rule !== 'string') continue
    const match = EDIT_RULE.exec(rule.trim())
    if (match === null) continue
    const raw = match[1]
    const glob = raw === undefined ? '**' : raw.trim().replace(/^\.\//, '')
    if (glob === '' || glob.startsWith('/') || glob.startsWith('~')) continue
    globs.push(glob)
  }
  return globs
}

/** Reads the stage worktree's own `.claude/settings.json` — the file Claude Code applies to the session; missing or unparseable reads as no rules. */
export async function readStageEditAllow(cwd: string, deps: { readonly readJsonFile: <T>(path: string) => Promise<FileResult<T>> } = { readJsonFile }): Promise<readonly string[]> {
  const result = await deps.readJsonFile<SettingsShape>(pathOps.join(cwd, '.claude', 'settings.json'))
  if (!result.ok) return []
  return editAllowGlobs(result.value.permissions?.allow)
}
