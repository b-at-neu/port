// Writes a ticket's `## Pipeline Cost` comment. Cost bookkeeping, not a pipeline write: it sets no label, so it bypasses command.ts and the audit log, as the script it replaces always did.
import { randomUUID } from 'node:crypto'
import { gh as defaultGh } from '@/main/platform/gh'
import { removeFile as defaultRemoveFile, writeTextFile as defaultWriteTextFile } from '@/main/platform/files'
import { pathOps } from '@/main/platform/paths'
import type { LedgerWrite, LedgerWriter } from '@/types/budget'
import type { FileResult, GhRunner } from '@/types/platform'

interface LedgerWriterDeps {
  readonly gh?: GhRunner
  readonly writeTextFile?: (path: string, text: string) => Promise<FileResult<void>>
  readonly removeFile?: (path: string) => Promise<FileResult<void>>
  readonly scratchDir: string
  readonly randomUUID?: () => string
}

const firstLine = (text: string, fallback: string): string => text.trim().split('\n')[0] || fallback

export function createLedgerWriter(deps: LedgerWriterDeps): LedgerWriter {
  const gh = deps.gh ?? defaultGh
  const writeTextFile = deps.writeTextFile ?? defaultWriteTextFile
  const removeFile = deps.removeFile ?? defaultRemoveFile
  const uuid = deps.randomUUID ?? randomUUID

  /** `gh api`'s `@<file>` field syntax gets a multi-line ledger to the API without shell quoting. PATCH when `ref` names an existing comment, a new comment otherwise. */
  return async function writeLedger(params: { readonly repo: string; readonly issue: number; readonly ref: number | null; readonly body: string }): Promise<LedgerWrite> {
    const path = pathOps.join(deps.scratchDir, `budget-ledger-${String(params.issue)}-${uuid()}.md`)
    const written = await writeTextFile(path, params.body)
    if (!written.ok) return { ok: false, error: written.message }
    try {
      const args =
        params.ref !== null
          ? ['api', '-X', 'PATCH', `repos/${params.repo}/issues/comments/${String(params.ref)}`, '-F', `body=@${path}`]
          : ['api', `repos/${params.repo}/issues/${String(params.issue)}/comments`, '-F', `body=@${path}`]
      const result = await gh(args)
      if (result.ok) return { ok: true }
      if ('stderr' in result && result.stderr.trim() !== '') return { ok: false, error: firstLine(result.stderr, result.kind) }
      return { ok: false, error: result.kind === 'spawn-failed' ? result.message : result.kind }
    } finally {
      await removeFile(path)
    }
  }
}
