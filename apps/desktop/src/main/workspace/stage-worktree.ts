// Creates and releases the worktrees stage sessions run in, always from a fresh fetch of origin and never from the main checkout's HEAD.
import type { CommandResult, GitRunner } from '@/types/platform'
import type { CreateStageWorktreeParams, CreateStageWorktreeResult, ReleaseBranchOutcome } from '@/types/workspace'
import { pathOps as defaultPathOps } from '@/main/platform/paths'
import { pathExists } from '@/main/platform/files'
import { defaultRandom, ensureIgnored, hex6 } from '@/main/workspace/worktree'

const SLUG_LIMIT = 40
const SWEEP_MARKER = 'port.sessionBranchSweep'

function reasonOf(result: Exclude<CommandResult, { readonly ok: true }>): string {
  return 'stderr' in result && result.stderr.trim() !== '' ? result.stderr.trim() : result.kind
}

export function branchSlug(title: string): string {
  const dashed = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (dashed.length <= SLUG_LIMIT) return dashed === '' ? 'work' : dashed
  const head = dashed.slice(0, SLUG_LIMIT)
  const lastDash = head.lastIndexOf('-')
  const cut = dashed.charAt(SLUG_LIMIT) === '-' || lastDash <= 0 ? head : head.slice(0, lastDash)
  return cut.replace(/-+$/, '')
}

interface StartPlan {
  readonly branch: string | null
  readonly start: string
  readonly baseLabel: string
}

type PlanResult = { readonly ok: true; readonly plan: StartPlan } | { readonly ok: false; readonly message: string }

const failed = (message: string): { readonly ok: false; readonly message: string } => ({ ok: false, message })

async function remoteBranchesFor(git: GitRunner, root: string, number: number): Promise<readonly string[] | null> {
  const listed = await git(['ls-remote', '--heads', 'origin', `refs/heads/${String(number)}-*`], root)
  if (!listed.ok) return null
  const names: string[] = []
  for (const line of listed.stdout.split('\n')) {
    const ref = line.split('\t')[1]?.trim()
    if (ref !== undefined && ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length))
  }
  return names
}

async function planStart(params: CreateStageWorktreeParams): Promise<PlanResult> {
  const { git, root, agent, number, integration, target } = params
  const remote = (name: string): string => `refs/remotes/origin/${name}`

  if (agent === 'plan') return { ok: true, plan: { branch: null, start: remote(integration), baseLabel: `origin/${integration}` } }

  if (agent === 'review' || agent === 'revise') {
    if (target.kind !== 'pr' || target.headRefName === null) return failed(`PR #${String(number)} has no head branch to check out.`)
    const head = target.headRefName
    return { ok: true, plan: { branch: agent === 'revise' ? head : null, start: remote(head), baseLabel: agent === 'revise' ? head : `origin/${head}` } }
  }

  const matches = await remoteBranchesFor(git, root, number)
  if (matches === null) return failed(`Couldn't list the remote branches for #${String(number)}. Check the network and the remote, then retry.`)
  if (matches.length === 1 && matches[0] !== undefined) return { ok: true, plan: { branch: matches[0], start: remote(matches[0]), baseLabel: matches[0] } }

  const title = target.kind === 'issue' ? target.title : ''
  const name = `${String(number)}-${branchSlug(title)}`
  const valid = await git(['check-ref-format', '--branch', name], root)
  if (!valid.ok) return failed(`"${name}" is not a valid branch name.`)
  const start = matches.includes(name) ? remote(name) : remote(integration)
  return { ok: true, plan: { branch: name, start, baseLabel: name } }
}

type BranchCheck = { readonly ok: true; readonly exists: boolean } | { readonly ok: false; readonly message: string }

async function checkLocalBranch(git: GitRunner, root: string, branch: string, start: string): Promise<BranchCheck> {
  const listed = await git(['for-each-ref', '--format=%(refname)\t%(objectname)\t%(worktreepath)', `refs/heads/${branch}`], root)
  if (!listed.ok) return failed(`git for-each-ref failed: ${reasonOf(listed)}`)
  const row = listed.stdout.split('\n').map((line) => line.split('\t')).find((cols) => cols[0] === `refs/heads/${branch}`)
  if (row === undefined) return { ok: true, exists: false }

  const checkedOutAt = (row[2] ?? '').trim()
  if (checkedOutAt !== '') return failed(`Branch ${branch} is checked out in ${checkedOutAt}. Resume or restart that stage first.`)

  const ancestry = await git(['merge-base', '--is-ancestor', (row[1] ?? '').trim(), start], root)
  if (ancestry.ok) return { ok: true, exists: true }
  if (ancestry.kind === 'nonzero' && ancestry.code === 1) return failed(`Local branch ${branch} has commits that aren't on origin. Push or delete it, then retry.`)
  return failed(`git merge-base failed: ${reasonOf(ancestry)}`)
}

export async function createStageWorktree(params: CreateStageWorktreeParams): Promise<CreateStageWorktreeResult> {
  const { root, git } = params
  const ops = params.pathOps ?? defaultPathOps
  const random = params.random ?? defaultRandom

  const fetched = await git(['fetch', 'origin'], root)
  if (!fetched.ok) return failed(`Couldn't fetch origin: ${reasonOf(fetched)}. Check the network and the remote, then retry.`)

  const planned = await planStart(params)
  if (!planned.ok) return planned
  const { branch, start, baseLabel } = planned.plan

  const resolved = await git(['rev-parse', '--verify', `${start}^{commit}`], root)
  if (!resolved.ok) return failed(`Couldn't resolve ${start}: ${reasonOf(resolved)}`)
  const baseSha = resolved.stdout.trim()

  let local: BranchCheck = { ok: true, exists: false }
  if (branch !== null) {
    local = await checkLocalBranch(git, root, branch, start)
    if (!local.ok) return local
  }

  const base = `${params.agent}-${String(params.number)}`
  const folder = (await pathExists(ops.join(root, '.claude', 'worktrees', base))) ? `${base}-${hex6(random)}` : base
  const path = ops.join(root, '.claude', 'worktrees', folder)

  const addArgs = branch === null ? ['worktree', 'add', '--detach', path, baseSha] : ['worktree', 'add', local.exists ? '-B' : '-b', branch, path, baseSha]
  const added = await git(addArgs, root)
  if (!added.ok) return failed(`git worktree add failed: ${reasonOf(added)}`)

  const undo = (): Promise<void> => discardNewWorktree(git, root, path, local.exists ? null : branch)

  const ignored = await ensureIgnored(git, root, `.claude/worktrees/${folder}`)
  if (!ignored.ok) {
    await undo()
    return failed(ignored.message)
  }

  if (branch !== null) {
    const configured = await git(['config', `branch.${branch}.portBase`, baseSha], root)
    if (!configured.ok) {
      await undo()
      return failed(`could not record portBase: ${reasonOf(configured)}`)
    }
  }

  return { ok: true, path, branch, baseSha, baseLabel }
}

async function discardNewWorktree(git: GitRunner, root: string, path: string, createdBranch: string | null): Promise<void> {
  await git(['worktree', 'remove', '--force', path], root)
  if (createdBranch !== null) await git(['branch', '-D', createdBranch], root)
}

interface ReleaseStageBranchParams {
  readonly root: string
  readonly git: GitRunner
  readonly branch: string
  readonly baseSha: string
}

/** Deletes the branch only when nothing on it is unpublished; any doubt keeps it. */
export async function releaseStageBranch(params: ReleaseStageBranchParams): Promise<ReleaseBranchOutcome> {
  const { root, git, branch, baseSha } = params
  const tip = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root)
  if (!tip.ok) return tip.kind === 'nonzero' && tip.code === 1 ? 'deleted' : 'kept'

  if (tip.stdout.trim() !== baseSha) {
    const published = await git(['merge-base', '--is-ancestor', tip.stdout.trim(), `refs/remotes/origin/${branch}`], root)
    if (!published.ok) return 'kept'
  }

  const deleted = await git(['branch', '-D', branch], root)
  return deleted.ok ? 'deleted' : 'kept'
}

interface SweepParams {
  readonly root: string
  readonly git: GitRunner
}

interface SweepResult {
  readonly done: boolean
  readonly deleted: readonly string[]
}

async function sweepOne(git: GitRunner, root: string, branch: string, tip: string): Promise<'deleted' | 'kept' | 'error'> {
  const base = await git(['config', '--get', `branch.${branch}.portBase`], root)
  if (!base.ok && !(base.kind === 'nonzero' && base.code === 1)) return 'error'

  let removable = base.ok && base.stdout.trim() === tip
  if (!removable) {
    const containing = await git(['branch', '-r', '--contains', tip], root)
    if (!containing.ok) return 'error'
    removable = containing.stdout.trim() !== ''
  }
  if (!removable) return 'kept'

  const deleted = await git(['branch', '-D', branch], root)
  return deleted.ok ? 'deleted' : 'error'
}

/** One-time cleanup of `session/*` branches left by earlier stage runs; the marker is set only after a clean pass. */
export async function sweepSessionBranches(params: SweepParams): Promise<SweepResult> {
  const { root, git } = params
  const marker = await git(['config', '--get', SWEEP_MARKER], root)
  if (marker.ok && marker.stdout.trim() === 'done') return { done: true, deleted: [] }

  const listed = await git(['for-each-ref', '--format=%(refname)\t%(objectname)\t%(worktreepath)', 'refs/heads/session/'], root)
  if (!listed.ok) return { done: false, deleted: [] }

  const deleted: string[] = []
  let clean = true
  for (const line of listed.stdout.split('\n')) {
    const [ref, tip, worktreePath] = line.split('\t')
    if (ref === undefined || tip === undefined || !ref.startsWith('refs/heads/')) continue
    if ((worktreePath ?? '').trim() !== '') continue
    const branch = ref.slice('refs/heads/'.length)
    const outcome = await sweepOne(git, root, branch, tip.trim())
    if (outcome === 'deleted') deleted.push(branch)
    if (outcome === 'error') clean = false
  }

  if (!clean) return { done: false, deleted }
  const marked = await git(['config', SWEEP_MARKER, 'done'], root)
  return { done: marked.ok, deleted }
}
