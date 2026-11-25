// The "Allow from now on" writer: the rule's commit through the Git Data API (the operator's checkout is never touched), then a pull request into integration. One audit entry per attempt; never merges, force-updates a ref or deletes a branch.
import { createHash, randomUUID } from 'node:crypto'
import { describe } from '@/main/github/release'
import type { GitHubWriteContext } from '@/main/github/context'
import { pathOps } from '@/main/platform/paths'
import { removeFile, writeTextFile } from '@/main/platform/files'
import { appendAudit } from '@/main/github/writes/audit'
import type { ProposeAllowParams, StageDenial } from '@/types/stage'
import type { AllowAuditEntry, AllowWriteContext, AllowWriteResult } from '@/types/writes'
import { STAGE_PROMPT_NAMES } from '@/utils/stage/prompt'

const SLUG_CAP = 40

/** Deterministic, so a repeat Allow finds the same branch; the `allow/` prefix keeps the tick's `N-` duplicate-pull-request predicate from matching it. */
export function allowBranchName(rule: string): string {
  const slug = rule
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_CAP)
    .replace(/-+$/, '')
  return `allow/${slug === '' ? 'rule' : slug}-${createHash('sha1').update(rule).digest('hex').slice(0, 8)}`
}

type Step = { readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly stderr: string }

async function withScratch(request: AllowWriteContext, name: string, text: string, use: (path: string) => Promise<Step>): Promise<Step> {
  const path = pathOps.join(request.scratchDir, `allow-${name}-${randomUUID()}.txt`)
  const written = await writeTextFile(path, text)
  if (!written.ok) return { ok: false, stderr: written.message }
  try {
    return await use(path)
  } finally {
    await removeFile(path)
  }
}

async function run(ctx: GitHubWriteContext, argv: readonly string[]): Promise<Step> {
  const result = await ctx.ghWrite(argv)
  return result.ok ? { ok: true, stdout: result.stdout } : { ok: false, stderr: describe(result) }
}

async function postJson(ctx: GitHubWriteContext, request: AllowWriteContext, endpoint: string, body: unknown, calls: string[][]): Promise<Step> {
  return withScratch(request, endpoint.replace('/', '-'), JSON.stringify(body), (path) => {
    const argv = ['api', '--method', 'POST', `repos/${request.repo}/${endpoint}`, '--input', path, '--jq', '.sha']
    calls.push(argv)
    return run(ctx, argv)
  })
}

function bodyOf(rule: string, denial: StageDenial): string {
  const phase = STAGE_PROMPT_NAMES[denial.agent].toLowerCase()
  return `Adds \`${rule}\` to \`.claude/settings.json\` and \`extraAllow\` in \`.claude/port.config.json\`. Requested in port after the ${phase} stage on #${String(denial.number)} was denied: \`${denial.inputSummary}\`.\n`
}

function numberOf(url: string): number | null {
  const match = /\/pull\/(\d+)\s*$/.exec(url.trim())
  return match?.[1] === undefined ? null : Number(match[1])
}

async function attempt(ctx: GitHubWriteContext, request: AllowWriteContext, params: ProposeAllowParams, calls: string[][]): Promise<AllowWriteResult> {
  const branch = allowBranchName(params.rule)
  const tree = await postJson(ctx, request, 'git/trees', { base_tree: params.head.tree, tree: params.files.map((file) => ({ path: file.path, mode: '100644', type: 'blob', content: file.content })) }, calls)
  if (!tree.ok) return { ok: false, step: 'commit', message: tree.stderr }
  const commit = await postJson(ctx, request, 'git/commits', { message: `#0 allow ${params.rule} for stage sessions`, tree: tree.stdout.trim(), parents: [params.head.oid] }, calls)
  if (!commit.ok) return { ok: false, step: 'commit', message: commit.stderr }
  const ref = await postJson(ctx, request, 'git/refs', { ref: `refs/heads/${branch}`, sha: commit.stdout.trim() }, calls)
  if (!ref.ok) {
    const exists = /reference already exists/i.test(ref.stderr)
    return { ok: false, step: 'commit', message: exists ? `The branch ${branch} already exists without an open pull request. Delete it, then try again.` : ref.stderr }
  }

  const created = await withScratch(request, 'pr', bodyOf(params.rule, params.denial), (path) => {
    const argv = ['pr', 'create', '--repo', request.repo, '--base', params.integration, '--head', branch, '--title', `Allow ${params.rule} for stage sessions`, '--body-file', path]
    calls.push(argv)
    return run(ctx, argv)
  })
  if (!created.ok) return { ok: false, step: 'pr', message: created.stderr }
  const url = created.stdout.trim().split('\n').pop() ?? ''
  const number = numberOf(url)
  return number === null ? { ok: false, step: 'pr', message: `gh didn't return a pull request URL: ${url}` } : { ok: true, number, url }
}

/** Commits both `.claude/` files onto the integration head at `allow/<slug>-<hash>` and opens the pull request; no `Closes`, labels or assignee. */
export async function proposeAllowRule(ctx: GitHubWriteContext, request: AllowWriteContext, params: ProposeAllowParams): Promise<AllowWriteResult> {
  const calls: string[][] = []
  const outcome = await attempt(ctx, request, params, calls)
  const entry: AllowAuditEntry = {
    at: ctx.clock.now().toISOString(),
    repo: request.repo,
    repoId: request.repoId,
    action: 'allow-propose',
    rule: params.rule,
    call: calls.at(-1) ?? null,
    result: outcome.ok ? 'applied' : 'failed',
    failure: outcome.ok ? null : outcome.message,
  }
  await appendAudit(request.auditDir, entry)
  return outcome
}
