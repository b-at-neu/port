// Pure parser: `git diff` unified output -> `FileDiff[]`. No `GitRunner`, no filesystem — `changes.ts` owns invocation.
import type { DiffHunk, DiffLine, DiffSign, FileDiff } from '../../shared/sessions/transcript'

const DIFF_GIT_LINE = /^diff --git /
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const BINARY_LINE = /^Binary files .* and .* differ$/
const OLD_PATH_LINE = /^--- (?:a\/(.+)|\/dev\/null)$/
const NEW_PATH_LINE = /^\+\+\+ (?:b\/(.+)|\/dev\/null)$/

function signOf(line: string): DiffSign {
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'context'
}

/** Strips a trailing `\r` from line text without ever splitting on it — a CRLF file's hunks stay one line per line. */
function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

interface RawFileSection {
  readonly headerLines: readonly string[]
  readonly bodyLines: readonly string[]
}

function splitSections(lines: readonly string[]): readonly RawFileSection[] {
  const sections: RawFileSection[] = []
  let headerLines: string[] = []
  let bodyLines: string[] = []
  let inBody = false

  function flush(): void {
    if (headerLines.length > 0 || bodyLines.length > 0) sections.push({ headerLines, bodyLines })
    headerLines = []
    bodyLines = []
    inBody = false
  }

  for (const line of lines) {
    if (DIFF_GIT_LINE.test(line)) {
      flush()
      headerLines.push(line)
      continue
    }
    if (!inBody && HUNK_HEADER.test(line)) inBody = true
    if (inBody) bodyLines.push(line)
    else headerLines.push(line)
  }
  flush()
  return sections
}

function pathFromHeader(headerLines: readonly string[]): string | null {
  for (const line of headerLines) {
    const oldMatch = OLD_PATH_LINE.exec(line)
    if (oldMatch?.[1] !== undefined) return oldMatch[1]
    const newMatch = NEW_PATH_LINE.exec(line)
    if (newMatch?.[1] !== undefined) return newMatch[1]
  }
  // Fall back to `diff --git a/<path> b/<path>` when neither `---`/`+++` names one (pure mode changes).
  const gitLine = headerLines.find((line) => DIFF_GIT_LINE.test(line))
  if (gitLine === undefined) return null
  const match = /^diff --git a\/(.+) b\/(.+)$/.exec(gitLine)
  return match?.[2] ?? match?.[1] ?? null
}

function parseHunks(bodyLines: readonly string[]): readonly DiffHunk[] {
  const hunks: DiffHunk[] = []
  let current: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: DiffLine[] } | null = null

  for (const raw of bodyLines) {
    const headerMatch = HUNK_HEADER.exec(raw)
    if (headerMatch) {
      if (current !== null) hunks.push(current)
      current = {
        oldStart: Number(headerMatch[1]),
        oldLines: headerMatch[2] !== undefined ? Number(headerMatch[2]) : 1,
        newStart: Number(headerMatch[3]),
        newLines: headerMatch[4] !== undefined ? Number(headerMatch[4]) : 1,
        lines: [],
      }
      continue
    }
    if (current === null) continue
    // `\ No newline at end of file` annotates the previous line rather than adding one of its own.
    if (raw.startsWith('\\ No newline')) continue
    const line = stripCr(raw)
    current.lines.push({ sign: signOf(line), text: line })
  }
  if (current !== null) hunks.push(current)
  return hunks
}

function countSign(hunks: readonly DiffHunk[], sign: DiffSign): number {
  return hunks.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line.sign === sign).length, 0)
}

export interface ParsedDiff {
  readonly files: readonly FileDiff[]
  /** Paths `git diff` reported as `Binary files … differ` — never present in `files`. */
  readonly binary: readonly string[]
}

/** Parses `git diff --no-color --no-ext-diff --no-renames -U3`'s stdout. A rename is never produced
 *  by that invocation, so every section resolves to exactly one path. */
export function parseUnifiedDiff(stdout: string): ParsedDiff {
  const normalized = stdout.replace(/\r\n/g, '\n')
  const lines = normalized.length === 0 ? [] : normalized.replace(/\n$/, '').split('\n')
  const sections = splitSections(lines)

  const files: FileDiff[] = []
  const binary: string[] = []

  for (const section of sections) {
    const path = pathFromHeader(section.headerLines)
    if (path === null) continue

    if (section.headerLines.some((line) => BINARY_LINE.test(line))) {
      binary.push(path)
      continue
    }

    const isNewFile = section.headerLines.some((line) => line.startsWith('new file mode'))
    const hunks = parseHunks(section.bodyLines)
    files.push({ path, isNewFile, additions: countSign(hunks, 'add'), deletions: countSign(hunks, 'del'), hunks })
  }

  return { files, binary }
}
