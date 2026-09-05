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
        modules: { approvalGate: true, previewDatabase: true, release: true, scope: true },
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
    expect(entry.config.modules).toEqual({ approvalGate: true, previewDatabase: false, release: true, scope: true })
    expect(entry.config.reviewCycleCap).toBe(5)
  })

  it('previewDatabase: false leaves refreshBranch/refreshing disabled', async () => {
    const root = await makeRepoDir()
    await writeConfig(root, JSON.stringify({ repo: 'o/n' }))
    const entry = await inspectRepository(root, { git: fakeGit(root) })
    if (!('config' in entry)) throw new Error('unreachable')
    expect(entry.config.vocabulary.disabled).toEqual(expect.arrayContaining(['refreshBranch', 'refreshing']))
    expect(labelName(entry.config.vocabulary, 'refreshBranch')).toBeUndefined()
  })

  it('previewDatabase: true includes refreshBranch/refreshing', async () => {
    const root = await makeRepoDir()
    await writeConfig(root, JSON.stringify({ repo: 'o/n', modules: { previewDatabase: true } }))
    const entry = await inspectRepository(root, { git: fakeGit(root) })
    if (!('config' in entry)) throw new Error('unreachable')
    expect(entry.config.vocabulary.disabled).not.toEqual(expect.arrayContaining(['refreshBranch']))
    expect(labelName(entry.config.vocabulary, 'refreshBranch')).toBe('refresh branch')
  })

  it('a labels override reaches the vocabulary with source: config', async () => {
    const root = await makeRepoDir()
    await writeConfig(root, JSON.stringify({ repo: 'o/n', labels: { ready: 'go' } }))
    const entry = await inspectRepository(root, { git: fakeGit(root) })
    if (!('config' in entry)) throw new Error('unreachable')
    const readyLabel = entry.config.vocabulary.labels.find((l) => l.key === ('ready' satisfies LabelKey))
    expect(readyLabel).toEqual({ key: 'ready', name: 'go', source: 'config', module: 'core' })
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
