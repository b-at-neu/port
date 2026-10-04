import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { labelName } from '../../shared/labels/vocabulary'
import type { LabelKey } from '../../shared/labels/vocabulary'
import type { CommandResult } from '../platform'
import { inspectRepository } from './inspect'
import type { GitRunner } from './harness'

async function makeRepoDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'port-registry-inspect-'))
}

async function writeConfig(root: string, content: string): Promise<void> {
  await mkdir(join(root, '.claude'), { recursive: true })
  await writeFile(join(root, '.claude', 'port.config.json'), content)
}

async function writeClaudeMd(root: string, content: string): Promise<void> {
  await writeFile(join(root, 'CLAUDE.md'), content)
}

async function writeApprovalWorkflow(root: string, jobName: string): Promise<void> {
  await mkdir(join(root, '.github', 'workflows'), { recursive: true })
  await writeFile(join(root, '.github', 'workflows', 'approval-check.yml'), `name: approval gate\non: pull_request\njobs:\n  ${jobName}:\n    runs-on: ubuntu-latest\n`)
}

function ok(stdout: string): CommandResult {
  return { ok: true, stdout, stderr: '' }
}

/** A `git` runner that resolves `root` as the repository's own toplevel and
 *  reports a plain `dev` branch with no config history — enough for every
 *  case that isn't specifically exercising branch or history detection. */
const NOT_FOUND: CommandResult = { ok: false, kind: 'not-found', command: 'git', searched: [] }

function fakeGit(root: string, overrides: Partial<Record<string, (args: readonly string[]) => CommandResult>> = {}): GitRunner {
  return (args) => {
    const key: string = args[0] === 'rev-parse' && args.includes('--show-toplevel') ? 'root' : (args[0] ?? '')
    const override = overrides[key]
    if (override) return Promise.resolve(override(args))
    if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return Promise.resolve(ok(`${root}\n`))
    if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) return Promise.resolve(ok('dev\n'))
    if (args[0] === 'rev-list') return Promise.resolve(ok(''))
    if (args[0] === 'branch') return Promise.resolve(ok(''))
    return Promise.resolve(NOT_FOUND)
  }
}

describe('inspectRepository', () => {
  it('resolves a ready entry from a full config', async () => {
    const root = await makeRepoDir()
    await writeConfig(
      root,
      JSON.stringify({
        repo: 'acme/widgets',
        branches: { integration: 'dev', production: 'main' },
        models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
        modules: { approvalGate: true, release: true, scope: true },
        reviewCycleCap: 3,
      }),
    )
    const entry = await inspectRepository(root, { git: fakeGit(root) })
    if (!('config' in entry)) throw new Error('unreachable')
    expect(entry.status).toBe('ready')
    expect(entry.config.repo).toBe('acme/widgets')
    expect(entry.config.owner).toBe('acme')
    expect(entry.config.name).toBe('widgets')
    expect(entry.config.reviewCycleCap).toBe(3)
    expect(entry.displayName).toBe('acme/widgets')
  })

  it('applies every default for a minimal config', async () => {
    const root = await makeRepoDir()
    await writeConfig(root, JSON.stringify({ repo: 'o/n' }))
    const entry = await inspectRepository(root, { git: fakeGit(root) })
    if (!('config' in entry)) throw new Error('unreachable')
    expect(entry.config.branches).toEqual({ integration: 'dev', production: 'main' })
    expect(entry.config.models).toEqual({ plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' })
    expect(entry.config.modules).toEqual({ approvalGate: true, release: true, scope: true })
    expect(entry.config.reviewCycleCap).toBe(5)
    expect(entry.config.commands).toEqual({ worktrees: null, budget: null })
    expect(entry.config.concurrency).toEqual({ sharedFiles: [], overlapThreshold: 2 })
  })

  it('resolves commands.worktrees onto the config when present (#86)', async () => {
    const root = await makeRepoDir()
    await writeConfig(root, JSON.stringify({ repo: 'o/n', commands: { worktrees: 'node scripts/port-worktrees.mjs' } }))
    const entry = await inspectRepository(root, { git: fakeGit(root) })
    if (!('config' in entry)) throw new Error('unreachable')
    expect(entry.config.commands).toEqual({ worktrees: 'node scripts/port-worktrees.mjs', budget: null })
  })

  it('falls back to null for a wrong-shaped commands.worktrees rather than carrying it through', async () => {
    const root = await makeRepoDir()
    await writeConfig(root, JSON.stringify({ repo: 'o/n', commands: { worktrees: 42 } }))
    const entry = await inspectRepository(root, { git: fakeGit(root) })
    if (!('config' in entry)) throw new Error('unreachable')
    expect(entry.config.commands).toEqual({ worktrees: null, budget: null })
    const schemaDiagnostic = entry.diagnostics.find((d) => d.kind === 'schema-violations')
    expect(schemaDiagnostic).toBeDefined()
  })

  it('resolves concurrency onto the config when present (#106)', async () => {
    const root = await makeRepoDir()
    await writeConfig(root, JSON.stringify({ repo: 'o/n', concurrency: { sharedFiles: ['docs/ENGINEERING.md'], overlapThreshold: 3 } }))
    const entry = await inspectRepository(root, { git: fakeGit(root) })
    if (!('config' in entry)) throw new Error('unreachable')
    expect(entry.config.concurrency).toEqual({ sharedFiles: ['docs/ENGINEERING.md'], overlapThreshold: 3 })
  })

  it('falls back to the schema defaults for an unresolvable concurrency value rather than holding everything', async () => {
    const root = await makeRepoDir()
    await writeConfig(root, JSON.stringify({ repo: 'o/n', concurrency: { overlapThreshold: 0 } }))
    const entry = await inspectRepository(root, { git: fakeGit(root) })
    if (!('config' in entry)) throw new Error('unreachable')
    expect(entry.config.concurrency).toEqual({ sharedFiles: [], overlapThreshold: 2 })
    const schemaDiagnostic = entry.diagnostics.find((d) => d.kind === 'schema-violations')
    expect(schemaDiagnostic).toBeDefined()
  })

  it('resolves refreshBranch/refreshing as core, always enabled', async () => {
    const root = await makeRepoDir()
    await writeConfig(root, JSON.stringify({ repo: 'o/n' }))
    const entry = await inspectRepository(root, { git: fakeGit(root) })
    if (!('config' in entry)) throw new Error('unreachable')
    expect(entry.config.vocabulary.disabled).toEqual([])
    expect(labelName(entry.config.vocabulary, 'refreshBranch')).toBe('refresh branch')
  })

  it('a labels override reaches the vocabulary with source: config', async () => {
    const root = await makeRepoDir()
    await writeConfig(root, JSON.stringify({ repo: 'o/n', labels: { ready: 'go' } }))
    const entry = await inspectRepository(root, { git: fakeGit(root) })
    if (!('config' in entry)) throw new Error('unreachable')
    const readyLabel = entry.config.vocabulary.labels.find((l) => l.key === ('ready' satisfies LabelKey))
    expect(readyLabel).toEqual({ key: 'ready', name: 'go', source: 'config', module: 'core', role: 'trigger' })
  })

  it('reports config-malformed for invalid JSON', async () => {
    const root = await makeRepoDir()
    await writeConfig(root, '{not json')
    const entry = await inspectRepository(root, { git: fakeGit(root) })
    if (!('problem' in entry)) throw new Error('unreachable')
    expect(entry.problem.kind).toBe('config-malformed')
  })

  it('reports config-invalid when repo is missing', async () => {
    const root = await makeRepoDir()
    await writeConfig(root, JSON.stringify({ branches: {} }))
    const entry = await inspectRepository(root, { git: fakeGit(root) })
    if (!('problem' in entry) || entry.problem.kind !== 'config-invalid') throw new Error('unreachable')
    expect(entry.problem.violations.length).toBeGreaterThan(0)
  })

  it('reports config-invalid when repo fails the slug pattern', async () => {
    const root = await makeRepoDir()
    await writeConfig(root, JSON.stringify({ repo: 'not-a-slug' }))
    const entry = await inspectRepository(root, { git: fakeGit(root) })
    if (!('problem' in entry)) throw new Error('unreachable')
    expect(entry.problem.kind).toBe('config-invalid')
  })

  it('surfaces an unknown key as a diagnostic while staying ready', async () => {
    const root = await makeRepoDir()
    await writeConfig(root, JSON.stringify({ repo: 'o/n', bogusKey: true }))
    const entry = await inspectRepository(root, { git: fakeGit(root) })
    if (!('config' in entry)) throw new Error('unreachable')
    expect(entry.status).toBe('ready')
    const schemaDiagnostic = entry.diagnostics.find((d) => d.kind === 'schema-violations')
    expect(schemaDiagnostic).toBeDefined()
    expect(entry.config.reviewCycleCap).toBe(5)
  })

  it('reports not-port-managed for a directory with no config file', async () => {
    const root = await makeRepoDir()
    const entry = await inspectRepository(root, { git: fakeGit(root) })
    if (!('problem' in entry) || entry.problem.kind !== 'not-port-managed') throw new Error('unreachable')
    expect(entry.problem.carriedBy).toEqual([])
    expect(entry.problem.currentBranch).toBe('dev')
  })

  it('reports not-port-managed naming the refs that do carry the config', async () => {
    const root = await makeRepoDir()
    const git = fakeGit(root, {
      'rev-list': () => ok('deadbeef\n'),
      branch: () => ok('main\n'),
      'ls-tree': () => ok('.claude/port.config.json\n'),
    })
    const entry = await inspectRepository(root, { git })
    if (!('problem' in entry) || entry.problem.kind !== 'not-port-managed') throw new Error('unreachable')
    expect(entry.problem.carriedBy).toEqual(['main'])
  })

  it('reports directory-missing for a path that does not exist', async () => {
    const root = await makeRepoDir()
    const entry = await inspectRepository(join(root, 'gone'), { git: fakeGit(root) })
    if (!('problem' in entry)) throw new Error('unreachable')
    expect(entry.problem.kind).toBe('directory-missing')
  })

  it('reports not-a-git-repository when git cannot resolve a toplevel', async () => {
    const root = await makeRepoDir()
    const git: GitRunner = () => Promise.resolve({ ok: false, kind: 'not-found', command: 'git', searched: [] })
    const entry = await inspectRepository(root, { git })
    if (!('problem' in entry)) throw new Error('unreachable')
    expect(entry.problem.kind).toBe('not-a-git-repository')
  })
})

describe('inspectRepository — CLAUDE.md port-overrides (#300)', () => {
  it('applies a labels.<key> override onto the vocabulary, with source CLAUDE.md, and lists it', async () => {
    const root = await makeRepoDir()
    await writeConfig(root, JSON.stringify({ repo: 'o/n' }))
    await writeClaudeMd(root, '<!-- port-overrides:begin -->\n```port-overrides\nlabels.ready = go  # this repo already used this word\n```\n<!-- port-overrides:end -->\n')
    const entry = await inspectRepository(root, { git: fakeGit(root) })
    if (!('config' in entry)) throw new Error('unreachable')
    const readyLabel = entry.config.vocabulary.labels.find((l) => l.key === ('ready' satisfies LabelKey))
    expect(readyLabel).toEqual({ key: 'ready', name: 'go', source: 'CLAUDE.md', module: 'core', role: 'trigger' })
    expect(entry.config.overrides).toEqual([{ path: 'labels.ready', value: 'go', reason: 'this repo already used this word', portDefault: 'ready', source: 'CLAUDE.md' }])
  })

  it('applies a reviewCycleCap override onto the config', async () => {
    const root = await makeRepoDir()
    await writeConfig(root, JSON.stringify({ repo: 'o/n' }))
    await writeClaudeMd(root, '<!-- port-overrides:begin -->\n```port-overrides\nreviewCycleCap = 2  # test\n```\n<!-- port-overrides:end -->\n')
    const entry = await inspectRepository(root, { git: fakeGit(root) })
    if (!('config' in entry)) throw new Error('unreachable')
    expect(entry.config.reviewCycleCap).toBe(2)
  })

  it('reports a refused line as an override-refused diagnostic, without disturbing the rest of the card', async () => {
    const root = await makeRepoDir()
    await writeConfig(root, JSON.stringify({ repo: 'o/n' }))
    await writeClaudeMd(root, '<!-- port-overrides:begin -->\n```port-overrides\ncommands.checks = node x.ts  # different runner\n```\n<!-- port-overrides:end -->\n')
    const entry = await inspectRepository(root, { git: fakeGit(root) })
    if (!('config' in entry)) throw new Error('unreachable')
    expect(entry.status).toBe('ready')
    const refused = entry.diagnostics.find((d) => d.kind === 'override-refused')
    expect(refused).toEqual({ kind: 'override-refused', path: 'commands.checks', line: 'commands.checks = node x.ts  # different runner', reason: "'commands.checks' is the permission surface the guard hook allowlists from — never overridable, no exception" })
  })

  it('no block at all leaves the card byte-identical to today, with no overrides listed', async () => {
    const root = await makeRepoDir()
    await writeConfig(root, JSON.stringify({ repo: 'o/n' }))
    const entry = await inspectRepository(root, { git: fakeGit(root) })
    if (!('config' in entry)) throw new Error('unreachable')
    expect(entry.config.overrides).toEqual([])
    expect(entry.diagnostics.some((d) => d.kind === 'override-refused')).toBe(false)
  })

  it('folds the approval-check.yml job name in as an infrastructure disposition', async () => {
    const root = await makeRepoDir()
    await writeConfig(root, JSON.stringify({ repo: 'o/n' }))
    await writeApprovalWorkflow(root, 'approval-check')
    const entry = await inspectRepository(root, { git: fakeGit(root) })
    if (!('config' in entry)) throw new Error('unreachable')
    expect(entry.config.checkDispositions).toEqual({ 'approval-check': { disposition: 'infrastructure', source: 'approval-gate' } })
  })

  it('a modules.approvalGate = false override turns the carve-out off — no excused check at all', async () => {
    const root = await makeRepoDir()
    await writeConfig(root, JSON.stringify({ repo: 'o/n' }))
    await writeApprovalWorkflow(root, 'approval-check')
    await writeClaudeMd(root, '<!-- port-overrides:begin -->\n```port-overrides\nmodules.approvalGate = false  # test\n```\n<!-- port-overrides:end -->\n')
    const entry = await inspectRepository(root, { git: fakeGit(root) })
    if (!('config' in entry)) throw new Error('unreachable')
    expect(entry.config.modules.approvalGate).toBe(false)
    expect(entry.config.checkDispositions).toEqual({})
  })

  it('a checks.<name> override folds in as a CLAUDE.md-sourced disposition', async () => {
    const root = await makeRepoDir()
    await writeConfig(root, JSON.stringify({ repo: 'o/n' }))
    await writeClaudeMd(root, '<!-- port-overrides:begin -->\n```port-overrides\nchecks.deploy-preview = infrastructure  # org preview-DB pool; red at capacity\n```\n<!-- port-overrides:end -->\n')
    const entry = await inspectRepository(root, { git: fakeGit(root) })
    if (!('config' in entry)) throw new Error('unreachable')
    expect(entry.config.checkDispositions['deploy-preview']).toEqual({ disposition: 'infrastructure', source: 'CLAUDE.md' })
  })

  it('reports effective-config-unreadable when CLAUDE.md cannot be read as a file', async () => {
    const root = await makeRepoDir()
    await writeConfig(root, JSON.stringify({ repo: 'o/n' }))
    // A directory named CLAUDE.md fails every platform's readFile the same
    // way (EISDIR), the cross-platform stand-in for a permission failure
    // this suite cannot portably arrange otherwise.
    await mkdir(join(root, 'CLAUDE.md'), { recursive: true })
    const entry = await inspectRepository(root, { git: fakeGit(root) })
    if (!('problem' in entry) || entry.problem.kind !== 'effective-config-unreadable') throw new Error('unreachable')
    expect(entry.problem.file).toBe('CLAUDE.md')
  })

  it('reports effective-config-unreadable when approval-check.yml cannot be read as a file', async () => {
    const root = await makeRepoDir()
    await writeConfig(root, JSON.stringify({ repo: 'o/n' }))
    await mkdir(join(root, '.github', 'workflows', 'approval-check.yml'), { recursive: true })
    const entry = await inspectRepository(root, { git: fakeGit(root) })
    if (!('problem' in entry) || entry.problem.kind !== 'effective-config-unreadable') throw new Error('unreachable')
    expect(entry.problem.file).toBe('.github/workflows/approval-check.yml')
  })
})
