// The `@` suggestion list's own file source: git's own listing when `cwd` is a work tree, a bounded walk otherwise.
import type { Platform } from '@/main/platform'
import type { CommandResult, GitLinesResult } from '@/types/platform'

export const MAX_FILES = 20_000

/** Directories a non-git walk never descends into, mirroring a typical `.gitignore`. */
const SKIP_DIRECTORY_NAMES = new Set(['node_modules'])

const MAX_WALK_DEPTH = 8

type FileListingResult = { readonly ok: true; readonly files: readonly string[]; readonly truncated: boolean } | { readonly ok: false; readonly message: string }

async function walk(root: string, fs: Platform['fs']): Promise<FileListingResult> {
  const files: string[] = []
  let truncated = false

  async function visit(absolute: string, relative: string, depth: number): Promise<void> {
    if (truncated || depth > MAX_WALK_DEPTH) return
    const result = await fs.list(absolute)
    if (!result.ok) throw new Error(result.message)
    for (const entry of result.value) {
      if (truncated) return
      if (entry.kind === 'directory') {
        if (entry.name.startsWith('.') || SKIP_DIRECTORY_NAMES.has(entry.name)) continue
        await visit(`${absolute}/${entry.name}`, relative === '' ? entry.name : `${relative}/${entry.name}`, depth + 1)
        continue
      }
      if (entry.kind !== 'file') continue
      if (files.length >= MAX_FILES) {
        truncated = true
        return
      }
      files.push(relative === '' ? entry.name : `${relative}/${entry.name}`)
    }
  }

  try {
    await visit(root, '', 0)
    return { ok: true, files, truncated }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

function linesOf(result: CommandResult): GitLinesResult {
  if (!result.ok) return result
  const trimmed = result.stdout.replace(/\r?\n$/, '')
  return { ok: true, lines: trimmed === '' ? [] : trimmed.split(/\r?\n/) }
}

function fromGitLines(result: GitLinesResult): FileListingResult | null {
  if (!result.ok) return null
  const truncated = result.lines.length > MAX_FILES
  return { ok: true, files: truncated ? result.lines.slice(0, MAX_FILES) : result.lines, truncated }
}

/** Lists every file under `cwd`, relative and forward-slashed — git's own
 *  listing when `cwd` is a work tree, a bounded walk otherwise. */
export async function listSessionFiles(ctx: Pick<Platform, 'git' | 'fs'>, cwd: string): Promise<FileListingResult> {
  const result = await ctx.git(['ls-files', '--cached', '--others', '--exclude-standard'], cwd)
  const fromGit = fromGitLines(linesOf(result))
  if (fromGit !== null) return fromGit
  return walk(cwd, ctx.fs)
}
