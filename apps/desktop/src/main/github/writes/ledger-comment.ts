// Writes a ticket's `## Pipeline Cost` comment. Cost bookkeeping, not a pipeline write: it sets no label, so it bypasses command.ts and the audit log, as the script it replaces always did.
import { randomUUID } from 'node:crypto'
import type { LedgerWriteContext } from '@/main/github/context'
import { pathOps } from '@/main/platform/paths'
import type { LedgerWrite } from '@/main/github/budget-ledger'

const firstLine = (text: string, fallback: string): string => text.trim().split('\n')[0] || fallback

/** `gh api`'s `@<file>` field syntax gets a multi-line ledger to the API without shell quoting. PATCH when `ref` names an existing comment, a new comment otherwise. */
export async function writeLedger(ctx: LedgerWriteContext, params: { readonly repo: string; readonly issue: number; readonly ref: number | null; readonly body: string; readonly scratchDir: string }): Promise<LedgerWrite> {
  const path = pathOps.join(params.scratchDir, `budget-ledger-${String(params.issue)}-${randomUUID()}.md`)
  const written = await ctx.fs.writeText(path, params.body)
  if (!written.ok) return { ok: false, error: written.message }
  try {
    const args =
      params.ref !== null
        ? ['api', '-X', 'PATCH', `repos/${params.repo}/issues/comments/${String(params.ref)}`, '-F', `body=@${path}`]
        : ['api', `repos/${params.repo}/issues/${String(params.issue)}/comments`, '-F', `body=@${path}`]
    const result = await ctx.ghWrite(args)
    if (result.ok) return { ok: true }
    if ('stderr' in result && result.stderr.trim() !== '') return { ok: false, error: firstLine(result.stderr, result.kind) }
    return { ok: false, error: result.kind === 'spawn-failed' ? result.message : result.kind }
  } finally {
    await ctx.fs.remove(path)
  }
}
