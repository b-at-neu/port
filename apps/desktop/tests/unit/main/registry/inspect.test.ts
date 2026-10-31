import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { labelName } from '@/utils/labels/vocabulary'
import type { LabelKey } from '@/utils/labels/vocabulary'
import type { CommandResult } from '@/types/platform'
import { inspectRepository } from '@/main/registry/inspect'
import type { GitRunner } from '@/types/platform'

type OriginHead = 'present' | 'missing' | 'restorable'

interface FakeRepo {
  readonly root: string
  readonly files: Record<string, string>
  readonly unreadable: Set<string>
  originHead: OriginHead
  readonly calls: string[][]
}

async function makeRepo(): Promise<FakeRepo> {
  const root = await mkdtemp(join(tmpdir(), 'port-registry-inspect-'))
  return { root, files: {}, unreadable: new Set(), originHead: 'present', calls: [] }
}

function writeConfig(repo: FakeRepo, content: string): void {
  repo.files['.claude/port.config.json'] = content
}

function writeClaudeMd(repo: FakeRepo, content: string): void {
  repo.files['CLAUDE.md'] = content
}

function writeApprovalWorkflow(repo: FakeRepo, jobName: string): void {
  repo.files['.github/workflows/approval-check.yml'] = `name: approval gate\non: pull_request\njobs:\n  ${jobName}:\n    runs-on: ubuntu-latest\n`
}

function ok(stdout: string): CommandResult {
  return { ok: true, stdout, stderr: '' }
}

function nonzero(code: number, stderr: string): CommandResult {
  return { ok: false, kind: 'nonzero', code, stdout: '', stderr }
}

const NOT_FOUND: CommandResult = { ok: false, kind: 'not-found', command: 'git', searched: [] }
const SHOW_PREFIX = 'refs/remotes/origin/HEAD:'

/** Serves `repo.files` as the blobs at origin/HEAD and reports `dev` as the default branch. */
function fakeGit(repo: FakeRepo, overrides: Partial<Record<string, (args: readonly string[]) => CommandResult>> = {}): GitRunner {
  let restored = false
  return (args) => {
    repo.calls.push([...args])
    const key: string = args[0] === 'rev-parse' && args.includes('--show-toplevel') ? 'root' : (args[0] ?? '')
    const override = overrides[key]
    if (override) return Promise.resolve(override(args))
    if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return Promise.resolve(ok(`${repo.root}\n`))
    if (args[0] === 'rev-parse' && args.includes('--verify')) {
      return Promise.resolve(repo.originHead === 'present' || restored ? ok('deadbeef\n') : nonzero(1, ''))
    }
    if (args[0] === 'remote' && args[1] === 'set-head') {
      if (repo.originHead !== 'restorable') return Promise.resolve(nonzero(128, "error: No such remote 'origin'"))
      restored = true
      return Promise.resolve(ok('origin/HEAD set to dev\n'))
    }
    if (args[0] === 'symbolic-ref') return Promise.resolve(ok('origin/dev\n'))
    if (args[0] === 'show' && args[1]?.startsWith(SHOW_PREFIX) === true) {
      const rel = args[1].slice(SHOW_PREFIX.length)
      if (repo.unreadable.has(rel)) return Promise.resolve(nonzero(128, 'fatal: unable to read blob'))
      const content = repo.files[rel]
      if (content === undefined) return Promise.resolve(nonzero(128, `fatal: path '${rel}' does not exist in '${SHOW_PREFIX.slice(0, -1)}'`))
      return Promise.resolve(ok(content))
    }
    if (args[0] === 'rev-list') return Promise.resolve(ok(''))
    if (args[0] === 'branch') return Promise.resolve(ok(''))
    return Promise.resolve(NOT_FOUND)
  }
}

async function readyEntry(repo: FakeRepo) {
  const entry = await inspectRepository(repo.root, { git: fakeGit(repo) })
  if (!('config' in entry)) throw new Error('unreachable')
  return entry
}

describe('inspectRepository', () => {
  it('resolves a ready entry from a full config', async () => {
    const repo = await makeRepo()
    writeConfig(
      repo,
      JSON.stringify({
        repo: 'acme/widgets',
        branches: { integration: 'dev', production: 'main' },
        models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
        modules: { approvalGate: true, release: true, scope: true },
        reviewCycleCap: 3,
      }),
    )
    const entry = await readyEntry(repo)
    expect(entry.status).toBe('ready')
    expect(entry.config.repo).toBe('acme/widgets')
    expect(entry.config.owner).toBe('acme')
    expect(entry.config.name).toBe('widgets')
    expect(entry.config.reviewCycleCap).toBe(3)
    expect(entry.displayName).toBe('acme/widgets')
  })

  it('applies every default for a minimal config', async () => {
    const repo = await makeRepo()
    writeConfig(repo, JSON.stringify({ repo: 'o/n' }))
    const entry = await readyEntry(repo)
    expect(entry.config.branches).toEqual({ integration: 'dev', production: 'main' })
    expect(entry.config.models).toEqual({ plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' })
    expect(entry.config.modules).toEqual({ approvalGate: true, release: true, scope: true })
    expect(entry.config.reviewCycleCap).toBe(5)
    expect(entry.config.commands).toEqual({ worktrees: null, budget: null })
    expect(entry.config.concurrency).toEqual({ sharedFiles: [], overlapThreshold: 2 })
  })

  it('resolves commands.worktrees onto the config when present', async () => {
    const repo = await makeRepo()
    writeConfig(repo, JSON.stringify({ repo: 'o/n', commands: { worktrees: 'node scripts/port-worktrees.mjs' } }))
    const entry = await readyEntry(repo)
    expect(entry.config.commands).toEqual({ worktrees: 'node scripts/port-worktrees.mjs', budget: null })
  })

  it('falls back to null for a wrong-shaped commands.worktrees rather than carrying it through', async () => {
    const repo = await makeRepo()
    writeConfig(repo, JSON.stringify({ repo: 'o/n', commands: { worktrees: 42 } }))
    const entry = await readyEntry(repo)
    expect(entry.config.commands).toEqual({ worktrees: null, budget: null })
    const schemaDiagnostic = entry.diagnostics.find((d) => d.kind === 'schema-violations')
    expect(schemaDiagnostic).toBeDefined()
  })

  it('resolves concurrency onto the config when present', async () => {
    const repo = await makeRepo()
    writeConfig(repo, JSON.stringify({ repo: 'o/n', concurrency: { sharedFiles: ['docs/ENGINEERING.md'], overlapThreshold: 3 } }))
    const entry = await readyEntry(repo)
    expect(entry.config.concurrency).toEqual({ sharedFiles: ['docs/ENGINEERING.md'], overlapThreshold: 3 })
  })

  it('falls back to the schema defaults for an unresolvable concurrency value rather than holding everything', async () => {
    const repo = await makeRepo()
    writeConfig(repo, JSON.stringify({ repo: 'o/n', concurrency: { overlapThreshold: 0 } }))
    const entry = await readyEntry(repo)
    expect(entry.config.concurrency).toEqual({ sharedFiles: [], overlapThreshold: 2 })
    const schemaDiagnostic = entry.diagnostics.find((d) => d.kind === 'schema-violations')
    expect(schemaDiagnostic).toBeDefined()
  })

  it('resolves refreshBranch/refreshing as core, always enabled', async () => {
    const repo = await makeRepo()
    writeConfig(repo, JSON.stringify({ repo: 'o/n' }))
    const entry = await readyEntry(repo)
    expect(entry.config.vocabulary.disabled).toEqual([])
    expect(labelName(entry.config.vocabulary, 'refreshBranch')).toBe('refresh branch')
  })

  it('a labels override reaches the vocabulary with source: config', async () => {
    const repo = await makeRepo()
    writeConfig(repo, JSON.stringify({ repo: 'o/n', labels: { ready: 'go' } }))
    const entry = await readyEntry(repo)
    const readyLabel = entry.config.vocabulary.labels.find((l) => l.key === ('ready' satisfies LabelKey))
    expect(readyLabel).toEqual({ key: 'ready', name: 'go', source: 'config', module: 'core', role: 'trigger' })
  })

  it('reports config-malformed for invalid JSON', async () => {
    const repo = await makeRepo()
    writeConfig(repo, '{not json')
    const entry = await inspectRepository(repo.root, { git: fakeGit(repo) })
    if (!('problem' in entry)) throw new Error('unreachable')
    expect(entry.problem.kind).toBe('config-malformed')
  })

  it('reports config-invalid when repo is missing', async () => {
    const repo = await makeRepo()
    writeConfig(repo, JSON.stringify({ branches: {} }))
    const entry = await inspectRepository(repo.root, { git: fakeGit(repo) })
    if (!('problem' in entry) || entry.problem.kind !== 'config-invalid') throw new Error('unreachable')
    expect(entry.problem.violations.length).toBeGreaterThan(0)
  })

  it('reports config-invalid when repo fails the slug pattern', async () => {
    const repo = await makeRepo()
    writeConfig(repo, JSON.stringify({ repo: 'not-a-slug' }))
    const entry = await inspectRepository(repo.root, { git: fakeGit(repo) })
    if (!('problem' in entry)) throw new Error('unreachable')
    expect(entry.problem.kind).toBe('config-invalid')
  })

  it('surfaces an unknown key as a diagnostic while staying ready', async () => {
    const repo = await makeRepo()
    writeConfig(repo, JSON.stringify({ repo: 'o/n', bogusKey: true }))
    const entry = await readyEntry(repo)
    expect(entry.status).toBe('ready')
    const schemaDiagnostic = entry.diagnostics.find((d) => d.kind === 'schema-violations')
    expect(schemaDiagnostic).toBeDefined()
    expect(entry.config.reviewCycleCap).toBe(5)
  })

  it('reports not-port-managed for a default branch with no config file', async () => {
    const repo = await makeRepo()
    const entry = await inspectRepository(repo.root, { git: fakeGit(repo) })
    if (!('problem' in entry) || entry.problem.kind !== 'not-port-managed') throw new Error('unreachable')
    expect(entry.problem.carriedBy).toEqual([])
    expect(entry.problem.ref).toBe('origin/dev')
  })

  it('reports not-port-managed naming the refs that do carry the config', async () => {
    const repo = await makeRepo()
    const git = fakeGit(repo, {
      'rev-list': () => ok('deadbeef\n'),
      branch: () => ok('main\n'),
      'ls-tree': () => ok('.claude/port.config.json\n'),
    })
    const entry = await inspectRepository(repo.root, { git })
    if (!('problem' in entry) || entry.problem.kind !== 'not-port-managed') throw new Error('unreachable')
    expect(entry.problem.carriedBy).toEqual(['main'])
  })

  it('keeps the git-unavailable diagnostic when the carrier search cannot run git', async () => {
    const repo = await makeRepo()
    const git = fakeGit(repo, { 'rev-list': () => NOT_FOUND })
    const entry = await inspectRepository(repo.root, { git })
    if (!('problem' in entry)) throw new Error('unreachable')
    expect(entry.diagnostics).toEqual([{ kind: 'git-unavailable' }])
  })

  it('reports directory-missing for a path that does not exist', async () => {
    const repo = await makeRepo()
    const entry = await inspectRepository(join(repo.root, 'gone'), { git: fakeGit(repo) })
    if (!('problem' in entry)) throw new Error('unreachable')
    expect(entry.problem.kind).toBe('directory-missing')
  })

  it('reports not-a-git-repository when git cannot resolve a toplevel', async () => {
    const repo = await makeRepo()
    const git: GitRunner = () => Promise.resolve({ ok: false, kind: 'not-found', command: 'git', searched: [] })
    const entry = await inspectRepository(repo.root, { git })
    if (!('problem' in entry)) throw new Error('unreachable')
    expect(entry.problem.kind).toBe('not-a-git-repository')
  })
})

describe('inspectRepository — the default branch at origin/HEAD', () => {
  it('reads the config from the ref, never from the checked-out files', async () => {
    const repo = await makeRepo()
    writeConfig(repo, JSON.stringify({ repo: 'o/n' }))
    await readyEntry(repo)
    expect(repo.calls.some((call) => call[0] === 'show' && call[1] === 'refs/remotes/origin/HEAD:.claude/port.config.json')).toBe(true)
  })

  it('restores a missing origin/HEAD once and still loads the repository', async () => {
    const repo = await makeRepo()
    repo.originHead = 'restorable'
    writeConfig(repo, JSON.stringify({ repo: 'o/n' }))
    const entry = await readyEntry(repo)
    expect(entry.status).toBe('ready')
    expect(repo.calls.some((call) => call[0] === 'remote' && call[1] === 'set-head')).toBe(true)
  })

  it('reports config-ref-unreadable when origin/HEAD cannot be restored', async () => {
    const repo = await makeRepo()
    repo.originHead = 'missing'
    writeConfig(repo, JSON.stringify({ repo: 'o/n' }))
    const entry = await inspectRepository(repo.root, { git: fakeGit(repo) })
    if (!('problem' in entry) || entry.problem.kind !== 'config-ref-unreadable') throw new Error('unreachable')
    expect(entry.problem.message).toContain("No such remote 'origin'")
  })

  it('reports config-unreadable when the config blob exists but cannot be read', async () => {
    const repo = await makeRepo()
    repo.unreadable.add('.claude/port.config.json')
    const entry = await inspectRepository(repo.root, { git: fakeGit(repo) })
    if (!('problem' in entry) || entry.problem.kind !== 'config-unreadable') throw new Error('unreachable')
    expect(entry.problem.message).toContain('unable to read blob')
  })

  it('raises no branch diagnostics whatever the main checkout is on', async () => {
    const repo = await makeRepo()
    writeConfig(repo, JSON.stringify({ repo: 'o/n' }))
    repo.files['.claude/settings.json'] = JSON.stringify({ permissions: { allow: ['Bash(git *)'] } })
    const entry = await readyEntry(repo)
    expect(entry.diagnostics).toEqual([])
  })

  it('reports permissions-missing when the default branch has no settings file', async () => {
    const repo = await makeRepo()
    writeConfig(repo, JSON.stringify({ repo: 'o/n' }))
    const entry = await readyEntry(repo)
    expect(entry.diagnostics).toContainEqual({ kind: 'permissions-missing' })
  })

  it('reports permissions-empty when the default branch allows nothing', async () => {
    const repo = await makeRepo()
    writeConfig(repo, JSON.stringify({ repo: 'o/n' }))
    repo.files['.claude/settings.json'] = JSON.stringify({ permissions: { allow: [] } })
    const entry = await readyEntry(repo)
    expect(entry.diagnostics).toContainEqual({ kind: 'permissions-empty' })
  })
})

describe('inspectRepository — CLAUDE.md port-overrides', () => {
  it('applies a labels.<key> override onto the vocabulary, with source CLAUDE.md, and lists it', async () => {
    const repo = await makeRepo()
    writeConfig(repo, JSON.stringify({ repo: 'o/n' }))
    writeClaudeMd(repo, '<!-- port-overrides:begin -->\n```port-overrides\nlabels.ready = go  # this repo already used this word\n```\n<!-- port-overrides:end -->\n')
    const entry = await readyEntry(repo)
    const readyLabel = entry.config.vocabulary.labels.find((l) => l.key === ('ready' satisfies LabelKey))
    expect(readyLabel).toEqual({ key: 'ready', name: 'go', source: 'CLAUDE.md', module: 'core', role: 'trigger' })
    expect(entry.config.overrides).toEqual([{ path: 'labels.ready', value: 'go', reason: 'this repo already used this word', portDefault: 'ready', source: 'CLAUDE.md' }])
  })

  it('applies a reviewCycleCap override onto the config', async () => {
    const repo = await makeRepo()
    writeConfig(repo, JSON.stringify({ repo: 'o/n' }))
    writeClaudeMd(repo, '<!-- port-overrides:begin -->\n```port-overrides\nreviewCycleCap = 2  # test\n```\n<!-- port-overrides:end -->\n')
    const entry = await readyEntry(repo)
    expect(entry.config.reviewCycleCap).toBe(2)
  })

  it('reports a refused line as an override-refused diagnostic, without disturbing the rest of the card', async () => {
    const repo = await makeRepo()
    writeConfig(repo, JSON.stringify({ repo: 'o/n' }))
    writeClaudeMd(repo, '<!-- port-overrides:begin -->\n```port-overrides\ncommands.checks = node x.ts  # different runner\n```\n<!-- port-overrides:end -->\n')
    const entry = await readyEntry(repo)
    expect(entry.status).toBe('ready')
    const refused = entry.diagnostics.find((d) => d.kind === 'override-refused')
    expect(refused).toEqual({ kind: 'override-refused', path: 'commands.checks', line: 'commands.checks = node x.ts  # different runner', reason: "'commands.checks' is the permission surface the guard hook allowlists from — never overridable, no exception" })
  })

  it('no block at all leaves the card byte-identical to today, with no overrides listed', async () => {
    const repo = await makeRepo()
    writeConfig(repo, JSON.stringify({ repo: 'o/n' }))
    const entry = await readyEntry(repo)
    expect(entry.config.overrides).toEqual([])
    expect(entry.diagnostics.some((d) => d.kind === 'override-refused')).toBe(false)
  })

  it('folds the approval-check.yml job name in as an infrastructure disposition', async () => {
    const repo = await makeRepo()
    writeConfig(repo, JSON.stringify({ repo: 'o/n' }))
    writeApprovalWorkflow(repo, 'approval-check')
    const entry = await readyEntry(repo)
    expect(entry.config.checkDispositions).toEqual({ 'approval-check': { disposition: 'infrastructure', source: 'approval-gate' } })
  })

  it('a modules.approvalGate = false override turns the carve-out off — no excused check at all', async () => {
    const repo = await makeRepo()
    writeConfig(repo, JSON.stringify({ repo: 'o/n' }))
    writeApprovalWorkflow(repo, 'approval-check')
    writeClaudeMd(repo, '<!-- port-overrides:begin -->\n```port-overrides\nmodules.approvalGate = false  # test\n```\n<!-- port-overrides:end -->\n')
    const entry = await readyEntry(repo)
    expect(entry.config.modules.approvalGate).toBe(false)
    expect(entry.config.checkDispositions).toEqual({})
  })

  it('a checks.<name> override folds in as a CLAUDE.md-sourced disposition', async () => {
    const repo = await makeRepo()
    writeConfig(repo, JSON.stringify({ repo: 'o/n' }))
    writeClaudeMd(repo, '<!-- port-overrides:begin -->\n```port-overrides\nchecks.deploy-preview = infrastructure  # org preview-DB pool; red at capacity\n```\n<!-- port-overrides:end -->\n')
    const entry = await readyEntry(repo)
    expect(entry.config.checkDispositions['deploy-preview']).toEqual({ disposition: 'infrastructure', source: 'CLAUDE.md' })
  })

  it('reports effective-config-unreadable when CLAUDE.md cannot be read at the ref', async () => {
    const repo = await makeRepo()
    writeConfig(repo, JSON.stringify({ repo: 'o/n' }))
    repo.unreadable.add('CLAUDE.md')
    const entry = await inspectRepository(repo.root, { git: fakeGit(repo) })
    if (!('problem' in entry) || entry.problem.kind !== 'effective-config-unreadable') throw new Error('unreachable')
    expect(entry.problem.file).toBe('CLAUDE.md')
  })

  it('reports effective-config-unreadable when approval-check.yml cannot be read at the ref', async () => {
    const repo = await makeRepo()
    writeConfig(repo, JSON.stringify({ repo: 'o/n' }))
    repo.unreadable.add('.github/workflows/approval-check.yml')
    const entry = await inspectRepository(repo.root, { git: fakeGit(repo) })
    if (!('problem' in entry) || entry.problem.kind !== 'effective-config-unreadable') throw new Error('unreachable')
    expect(entry.problem.file).toBe('.github/workflows/approval-check.yml')
  })
})
