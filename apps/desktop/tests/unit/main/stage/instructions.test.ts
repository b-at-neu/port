import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildStageContext, createStageInstructionsLoader, extractSection, loadStageInstructions, readStageConfigPointers, resolveInstalledPluginRoot, STAGE_PIPELINE_SECTIONS } from '@/main/stage/instructions'
import { readJsonFile, readTextFile } from '@/main/platform/files'
import { pathOps } from '@/main/platform/paths'
import { FIXTURE_REPOSITORIES, WIDGETS_ID } from '@/main/fixtures/repos'
import type { ReadyEntry } from '@/types/actions'
import type { StageLaunchRequest } from '@/types/dispatch'
import type { FileResult, GitRunner } from '@/types/platform'
import { makeTempDir } from '../../../fixtures/fs'
import type { StageAgent } from '@/types/tick'
import { LABEL_KEYS } from '@/utils/labels/vocabulary'
import { parseStagePrompt } from '@/utils/stage/prompt'

const ENTRY = FIXTURE_REPOSITORIES.find((r) => r.id === WIDGETS_ID) as ReadyEntry
const HOME = '/home/u/.claude'
const REPO = '/work/widgets'
const WORKTREE = '/work/widgets/.claude/worktrees/impl-52'

function fakeFiles(files: Readonly<Record<string, string>>) {
  const readTextFake = (path: string): Promise<FileResult<string>> => {
    const value = files[pathOps.toPosix(path)]
    return Promise.resolve(value === undefined ? { ok: false, kind: 'not-found', message: `${path} not found` } : { ok: true, value })
  }
  const readJsonFake = async <T>(path: string): Promise<FileResult<T>> => {
    const text = await readTextFake(path)
    if (!text.ok) return text
    return { ok: true, value: JSON.parse(text.value) as T }
  }
  return { readTextFile: readTextFake, readJsonFile: readJsonFake }
}

function fakeGit(config: string | null, calls: { cwd: string; args: readonly string[] }[] = []): GitRunner {
  return (args, cwd) => {
    calls.push({ cwd, args })
    if (args[0] !== 'show') return Promise.resolve({ ok: true, stdout: '', stderr: '' })
    if (config === null) return Promise.resolve({ ok: false, kind: 'nonzero', code: 128, stdout: '', stderr: `fatal: path '${args[1] ?? ''}' does not exist in 'refs/remotes/origin/HEAD'` })
    return Promise.resolve({ ok: true, stdout: config, stderr: '' })
  }
}

function installed(records: readonly object[]): string {
  return JSON.stringify({ version: 2, plugins: { 'port@port': records } })
}

const INSTALLED_FILE = `${HOME}/plugins/installed_plugins.json`
const INSTALLED_FILE_MESSAGE_PATH = pathOps.join(HOME, 'plugins', 'installed_plugins.json')

function resolve(records: readonly object[], overrides: { readonly repoRoot?: string } = {}) {
  const { readJsonFile: readJson } = fakeFiles({ [INSTALLED_FILE]: installed(records) })
  return resolveInstalledPluginRoot({ claudeHome: HOME, repoRoot: overrides.repoRoot ?? REPO, worktree: WORKTREE, ops: pathOps, readJsonFile: readJson })
}

describe('resolveInstalledPluginRoot', () => {
  const user = { scope: 'user', installPath: '/cache/user' }
  const project = { scope: 'project', projectPath: REPO, installPath: '/cache/project' }
  const local = { scope: 'local', projectPath: REPO, installPath: '/cache/local' }

  it('prefers a local record for this repository, then a project one, then the user one', async () => {
    expect(await resolve([user, project, local])).toEqual({ ok: true, root: '/cache/local' })
    expect(await resolve([user, project])).toEqual({ ok: true, root: '/cache/project' })
    expect(await resolve([user])).toEqual({ ok: true, root: '/cache/user' })
  })

  it('ignores a local or project record that belongs to another repository', async () => {
    expect(await resolve([user, { ...local, projectPath: '/work/elsewhere' }, { ...project, projectPath: '/work/elsewhere' }])).toEqual({ ok: true, root: '/cache/user' })
  })

  it('fails with a named message when the file has no record', async () => {
    const result = await resolve([])
    expect(result).toEqual({ ok: false, message: `no port@port install record in ${INSTALLED_FILE_MESSAGE_PATH}` })
  })

  it('fails when the install file cannot be read', async () => {
    const { readJsonFile: readJson } = fakeFiles({})
    const result = await resolveInstalledPluginRoot({ claudeHome: HOME, repoRoot: REPO, worktree: WORKTREE, ops: pathOps, readJsonFile: readJson })
    expect(result.ok).toBe(false)
  })

  it('refuses an install path inside the stage worktree', async () => {
    const result = await resolve([{ scope: 'user', installPath: `${WORKTREE}/plugins/port` }])
    expect(result).toMatchObject({ ok: false })
    expect(result.ok ? '' : result.message).toContain('inside the stage worktree')
  })
})

describe('extractSection', () => {
  const DOC = ['# Title', '', '## Alpha', 'a1', '### Alpha child', 'a2', '```bash', '# not a heading', '```', '## Beta', 'b1', '# Top', 'top'].join('\n')

  it('runs to the next heading of the same or higher level, keeping its subsections', () => {
    expect(extractSection(DOC, 'Alpha')).toBe(['## Alpha', 'a1', '### Alpha child', 'a2', '```bash', '# not a heading', '```'].join('\n'))
    expect(extractSection(DOC, 'Beta')).toBe('## Beta\nb1')
  })

  it('runs to the end of the document for the last section, and is null for a missing heading', () => {
    expect(extractSection(DOC, 'Top')).toBe('# Top\ntop')
    expect(extractSection(DOC, 'Gamma')).toBeNull()
  })
})

describe('loadStageInstructions', () => {
  const ROOT = '/cache/port'
  const AGENT = ['---', 'name: impl-agent', '---', '', 'You are the Impl agent at ${CLAUDE_PLUGIN_ROOT}/docs/PIPELINE.md.', '', '<!-- shell-discipline:begin -->', 'SHELL', '<!-- shell-discipline:end -->'].join('\n')
  const PIPELINE = [
    '## CLAUDE.md overrides',
    'overrides text',
    '## Quick start',
    'skip me',
    '### Operating rules (all stage agents)',
    'rules at ${CLAUDE_PLUGIN_ROOT}',
    '<!-- shell-discipline:begin -->',
    'SHELL',
    '<!-- shell-discipline:end -->',
    '<!-- label-cas:begin -->',
    'CAS',
    '<!-- label-cas:end -->',
    '## Label lifecycle',
    'labels',
    '## Stages and models',
    'later',
  ].join('\n')

  function load(files: Record<string, string>) {
    return loadStageInstructions({ pluginRoot: ROOT, agent: 'impl', ops: pathOps, readTextFile: fakeFiles(files).readTextFile })
  }

  it('strips frontmatter, fills the plugin root everywhere, and drops marker blocks the body already carries', async () => {
    const result = await load({ [`${ROOT}/agents/impl-agent.md`]: AGENT, [`${ROOT}/docs/PIPELINE.md`]: PIPELINE })
    expect(result.ok).toBe(true)
    const text = result.ok ? result.text : ''
    expect(text.startsWith('You are the Impl agent at /cache/port/docs/PIPELINE.md.')).toBe(true)
    expect(text).not.toContain('---')
    expect(text).not.toContain('${CLAUDE_PLUGIN_ROOT}')
    expect(text).toContain('rules at /cache/port')
    expect(text.split('<!-- shell-discipline:begin -->')).toHaveLength(2)
    expect(text).toContain('CAS')
    expect(text).toContain('overrides text')
    expect(text).toContain('labels')
    expect(text).not.toContain('skip me')
    expect(text).not.toContain('later')
  })

  it('names the missing heading', async () => {
    const result = await load({ [`${ROOT}/agents/impl-agent.md`]: AGENT, [`${ROOT}/docs/PIPELINE.md`]: '## CLAUDE.md overrides\nx\n' })
    expect(result).toMatchObject({ ok: false })
    expect(result.ok ? '' : result.message).toContain('Operating rules (all stage agents)')
  })

  it('names a missing agent file', async () => {
    const result = await load({ [`${ROOT}/docs/PIPELINE.md`]: PIPELINE })
    expect(result.ok ? '' : result.message).toContain('impl-agent.md')
  })
})

describe('loadStageInstructions against this repository plugin', () => {
  const REAL_ROOT = join(__dirname, '../../../../../../plugins/port')

  it.each<StageAgent>(['plan', 'impl', 'review', 'revise'])('resolves every section for the %s agent and leaves no plugin-root variable behind', async (agent) => {
    const result = await loadStageInstructions({ pluginRoot: REAL_ROOT, agent, ops: pathOps, readTextFile })
    expect(result.ok).toBe(true)
    const text = result.ok ? result.text : ''
    expect(text).not.toContain('${CLAUDE_PLUGIN_ROOT}')
    for (const title of STAGE_PIPELINE_SECTIONS) expect(text).toContain(title)
    for (const marker of ['shell-discipline', 'label-cas', 'standards-precedence']) {
      expect(text.split(`<!-- ${marker}:begin -->`).length - 1).toBeLessThanOrEqual(1)
    }
  })
})

describe('readStageConfigPointers', () => {
  it('reads docs and every configured command from the default branch, skipping nulls', async () => {
    const config = { docs: { engineering: 'docs/ENGINEERING.md', design: null }, commands: { bootstrap: ['pnpm install'], checks: [{ run: 'node scripts/checks.ts', fix: null }], artifacts: 'node a.mjs', tick: null } }
    const calls: { cwd: string; args: readonly string[] }[] = []
    const result = await readStageConfigPointers(REPO, fakeGit(JSON.stringify(config), calls))
    expect(result).toEqual({ ok: true, docs: { engineering: 'docs/ENGINEERING.md', design: null }, commands: { bootstrap: '["pnpm install"]', checks: '[{"run":"node scripts/checks.ts","fix":null}]', artifacts: 'node a.mjs' } })
    expect(calls.find((call) => call.args[0] === 'show')).toEqual({ cwd: REPO, args: ['show', 'refs/remotes/origin/HEAD:.claude/port.config.json'] })
  })

  it('fails when the config is not on the default branch', async () => {
    const result = await readStageConfigPointers(REPO, fakeGit(null))
    expect(result).toMatchObject({ ok: false })
    expect(result.ok ? '' : result.message).toContain('default branch')
  })

  it.each(['not json', 'null', '[]'])('fails on a config that is not a JSON object: %s', async (text) => {
    const result = await readStageConfigPointers(REPO, fakeGit(text))
    expect(result.ok).toBe(false)
  })
})

function launchRequest(overrides: Partial<StageLaunchRequest> = {}): StageLaunchRequest {
  const entry: ReadyEntry = {
    ...ENTRY,
    path: REPO,
    config: { ...ENTRY.config, overrides: [{ path: 'reviewCycleCap', value: 3, reason: 'small team', portDefault: 5, source: 'CLAUDE.md' }] },
    diagnostics: [{ kind: 'override-refused', path: 'commands.checks', line: 'commands.checks = x', reason: 'permission surface' }],
  }
  return { entry, agent: 'impl', number: 52, kind: 'issue', trigger: 'planApproved', model: 'sonnet', prompt: 'Implementation stage for issue #52. Run your pipeline stage for #52. Follow your Pre-flight, Label swap, Work, and Handoff steps exactly.', title: '#52 x', target: { kind: 'issue', title: 'x' }, ...overrides }
}

describe('buildStageContext', () => {
  const pointers = { ok: true, docs: { engineering: 'docs/ENGINEERING.md', design: null }, commands: { artifacts: 'node a.mjs' } } as const

  it('emits the keys in a fixed order, with every label, override and refused override', () => {
    const context = buildStageContext(launchRequest(), '/cache/port', pointers)
    const keys = context.map(([key]) => key)
    expect(keys.slice(0, 8)).toEqual(['stage', 'item', 'mode', 'models.impl', 'plugin-root', 'repo', 'branches.integration', 'branches.production'])
    expect(keys.filter((key) => key.startsWith('labels.')).length).toBeGreaterThan(10)
    expect(keys.filter((key) => key.startsWith('labels.')).every((key) => LABEL_KEYS.includes(key.slice('labels.'.length) as never))).toBe(true)
    expect(keys.indexOf('sessionRequiredPaths')).toBeGreaterThan(keys.lastIndexOf('modules.approvalGate'))
    expect(keys.indexOf('docs.engineering')).toBeGreaterThan(keys.indexOf('reviewCycleCap'))
    expect(keys.indexOf('commands.artifacts')).toBeGreaterThan(keys.indexOf('docs.design'))
    expect(context).toContainEqual(['item', 'issue #52'])
    expect(context).toContainEqual(['mode', 'implement'])
    expect(context).toContainEqual(['docs.design', 'null'])
    expect(context).toContainEqual(['override', 'reviewCycleCap = 3 (small team)'])
    expect(context).toContainEqual(['override-refused', 'commands.checks: permission surface'])
  })
})

describe('createStageInstructionsLoader', () => {
  const ROOT = '/cache/port'
  const files = {
    [INSTALLED_FILE]: installed([{ scope: 'user', installPath: ROOT }]),
    [`${ROOT}/agents/impl-agent.md`]: '---\nname: impl-agent\n---\nYou are the Impl agent.',
    [`${ROOT}/docs/PIPELINE.md`]: '## CLAUDE.md overrides\no\n## Quick start\nq\n### Operating rules (all stage agents)\nr\n## Label lifecycle\nl\n## Stages and models\ns\n',
  }
  const defaultBranchConfig = JSON.stringify({ docs: { engineering: null, design: null }, commands: { artifacts: 'node default.mjs' } })

  it('composes the dispatch line, the context and the installed instructions into one message', async () => {
    const load = createStageInstructionsLoader({ claudeHome: HOME, ops: pathOps, ...fakeFiles(files), git: fakeGit(defaultBranchConfig) })
    const result = await load(launchRequest(), WORKTREE)
    expect(result.ok).toBe(true)
    const text = result.ok ? result.text : ''
    expect(text.startsWith(launchRequest().prompt)).toBe(true)
    expect(parseStagePrompt(text)).toMatchObject({ stage: 'impl', kind: 'issue', number: 52, source: ROOT })
    expect(text).toContain('You are the Impl agent.')
    expect(text).toContain('repo: ')
  })

  it('takes commands from the default branch even when the worktree carries a different config', async () => {
    const worktreeConfig = JSON.stringify({ commands: { artifacts: 'node hijack.mjs' } })
    const load = createStageInstructionsLoader({ claudeHome: HOME, ops: pathOps, ...fakeFiles({ ...files, [`${WORKTREE}/.claude/port.config.json`]: worktreeConfig }), git: fakeGit(defaultBranchConfig) })
    const result = await load(launchRequest(), WORKTREE)
    const text = result.ok ? result.text : ''
    expect(text).toContain('commands.artifacts: node default.mjs')
    expect(text).not.toContain('hijack')
  })

  it('fails with the resolver message when the plugin is not installed', async () => {
    const load = createStageInstructionsLoader({ claudeHome: HOME, ops: pathOps, ...fakeFiles({ [INSTALLED_FILE]: installed([]) }), git: fakeGit(defaultBranchConfig) })
    const result = await load(launchRequest(), WORKTREE)
    expect(result).toEqual({ ok: false, message: `no port@port install record in ${INSTALLED_FILE_MESSAGE_PATH}` })
  })

  it('fails when the default branch has no config', async () => {
    const load = createStageInstructionsLoader({ claudeHome: HOME, ops: pathOps, ...fakeFiles(files), git: fakeGit(null) })
    const result = await load(launchRequest(), WORKTREE)
    expect(result).toMatchObject({ ok: false })
  })

  it('reads the installed plugin through the default file readers', async () => {
    const home = await makeTempDir('port-stage-home-')
    const pluginRoot = join(home, 'cache', 'port')
    await mkdir(join(home, 'plugins'), { recursive: true })
    await mkdir(join(pluginRoot, 'agents'), { recursive: true })
    await mkdir(join(pluginRoot, 'docs'), { recursive: true })
    await writeFile(join(home, 'plugins', 'installed_plugins.json'), installed([{ scope: 'user', installPath: pluginRoot }]), 'utf8')
    await writeFile(join(pluginRoot, 'agents', 'impl-agent.md'), '---\nname: impl-agent\n---\nYou are the Impl agent.', 'utf8')
    await writeFile(join(pluginRoot, 'docs', 'PIPELINE.md'), files[`${ROOT}/docs/PIPELINE.md`] ?? '', 'utf8')
    const real = createStageInstructionsLoader({ claudeHome: home, ops: pathOps, readTextFile, readJsonFile, git: fakeGit(defaultBranchConfig) })
    const result = await real(launchRequest(), WORKTREE)
    expect(result.ok).toBe(true)
    expect(result.ok ? result.text : '').toContain('You are the Impl agent.')
  })
})
