import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildStageContext, createStageInstructionsLoader, extractSection, loadStageInstructions, readStageConfigPointers, STAGE_PIPELINE_SECTIONS } from '@/main/stage/instructions'
import { readTextFile } from '@/main/platform/files'
import { pathOps } from '@/main/platform/paths'
import { FIXTURE_REPOSITORIES, WIDGETS_ID } from '../../../fixtures/app/repos'
import type { ReadyEntry } from '@/types/actions'
import type { StageLaunchRequest } from '@/types/dispatch'
import type { FileResult, GitRunner } from '@/types/platform'
import { makeTempDir } from '../../../fixtures/fs'
import type { StageAgent } from '@/types/tick'
import { LABEL_KEYS } from '@/utils/labels/vocabulary'
import { parseStagePrompt } from '@/utils/stage/prompt'

const ENTRY = FIXTURE_REPOSITORIES.find((r) => r.id === WIDGETS_ID) as ReadyEntry
const REPO = '/work/widgets'
const WORKTREE = '/work/widgets/.claude/worktrees/impl-52'

function fakeFiles(files: Readonly<Record<string, string>>) {
  const readTextFake = (path: string): Promise<FileResult<string>> => {
    const value = files[pathOps.toPosix(path)]
    return Promise.resolve(value === undefined ? { ok: false, kind: 'not-found', message: `${path} not found` } : { ok: true, value })
  }
  return { readTextFile: readTextFake }
}

function fakeGit(config: string | null, calls: { cwd: string; args: readonly string[] }[] = []): GitRunner {
  return (args, cwd) => {
    calls.push({ cwd, args })
    if (args[0] !== 'show') return Promise.resolve({ ok: true, stdout: '', stderr: '' })
    if (config === null) return Promise.resolve({ ok: false, kind: 'nonzero', code: 128, stdout: '', stderr: `fatal: path '${args[1] ?? ''}' does not exist in 'refs/remotes/origin/HEAD'` })
    return Promise.resolve({ ok: true, stdout: config, stderr: '' })
  }
}

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
  const ROOT = '/bundle/stage-prompts'
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

  it('strips frontmatter, fills the bundle root everywhere, and drops marker blocks the body already carries', async () => {
    const result = await load({ [`${ROOT}/agents/impl-agent.md`]: AGENT, [`${ROOT}/docs/PIPELINE.md`]: PIPELINE })
    expect(result.ok).toBe(true)
    const text = result.ok ? result.text : ''
    expect(text.startsWith('You are the Impl agent at /bundle/stage-prompts/docs/PIPELINE.md.')).toBe(true)
    expect(text).not.toContain('---')
    expect(text).not.toContain('${CLAUDE_PLUGIN_ROOT}')
    expect(text).toContain('rules at /bundle/stage-prompts')
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

describe('loadStageInstructions against the bundled stage prompts', () => {
  const REAL_ROOT = join(__dirname, '../../../../stage-prompts')

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

  it('has the review agent read both review facts from the stage context and derive neither itself', async () => {
    const result = await loadStageInstructions({ pluginRoot: REAL_ROOT, agent: 'review', ops: pathOps, readTextFile })
    const text = result.ok ? result.text : ''
    expect(text).toContain('review.cycle')
    expect(text).toContain('review.selfAuthored')
    expect(text).not.toContain('gh api user')
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
  return { entry, agent: 'impl', number: 52, kind: 'issue', trigger: 'planApproved', model: 'sonnet', prompt: 'Implementation stage for issue #52. Run your pipeline stage for #52. Follow your Pre-flight, Label swap, Work, and Handoff steps exactly.', title: '#52 x', target: { kind: 'issue', title: 'x' }, review: null, ...overrides }
}

describe('buildStageContext', () => {
  const pointers = { ok: true, docs: { engineering: 'docs/ENGINEERING.md', design: null }, commands: { artifacts: 'node a.mjs' } } as const

  it('emits the keys in a fixed order, with every label, override and refused override', () => {
    const context = buildStageContext(launchRequest(), '/bundle/stage-prompts', pointers)
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

  it('emits the review facts directly after reviewCycleCap for a review request', () => {
    const context = buildStageContext(launchRequest({ agent: 'review', kind: 'pull-request', trigger: 'readyForReview', review: { cycle: 2, selfAuthored: true } }), '/bundle/stage-prompts', pointers)
    const keys = context.map(([key]) => key)
    expect(keys.slice(keys.indexOf('reviewCycleCap'), keys.indexOf('reviewCycleCap') + 3)).toEqual(['reviewCycleCap', 'review.cycle', 'review.selfAuthored'])
    expect(context).toContainEqual(['review.cycle', '2'])
    expect(context).toContainEqual(['review.selfAuthored', 'true'])
  })

  it('emits no review facts for a stage that carries none', () => {
    const keys = buildStageContext(launchRequest(), '/bundle/stage-prompts', pointers).map(([key]) => key)
    expect(keys.some((key) => key.startsWith('review.'))).toBe(false)
  })
})

describe('createStageInstructionsLoader', () => {
  const ROOT = '/bundle/stage-prompts'
  const files = {
    [`${ROOT}/agents/impl-agent.md`]: '---\nname: impl-agent\ndescription: Implements a plan\ndisallowedTools: Agent\n---\nYou are the Impl agent.',
    [`${ROOT}/docs/PIPELINE.md`]: '## CLAUDE.md overrides\no\n## Quick start\nq\n### Operating rules (all stage agents)\nr\n## Label lifecycle\nl\n## Stages and models\ns\n',
  }
  const defaultBranchConfig = JSON.stringify({ docs: { engineering: null, design: null }, commands: { artifacts: 'node default.mjs' } })

  it('composes the dispatch line, the context and the bundled instructions into one message, with the inline agent', async () => {
    const load = createStageInstructionsLoader({ bundleRoot: ROOT, ops: pathOps, ...fakeFiles(files), git: fakeGit(defaultBranchConfig) })
    const result = await load(launchRequest(), WORKTREE)
    expect(result.ok).toBe(true)
    const text = result.ok ? result.text : ''
    expect(text.startsWith(launchRequest().prompt)).toBe(true)
    expect(parseStagePrompt(text)).toMatchObject({ stage: 'impl', kind: 'issue', number: 52, source: ROOT })
    expect(text).toContain('You are the Impl agent.')
    expect(text).toContain('repo: ')
    expect(text).toContain(`plugin-root: ${ROOT}`)
    expect(result.ok ? result.agent : null).toEqual({ name: 'impl-agent', definition: { description: 'Implements a plan', prompt: 'You are the Impl agent.', disallowedTools: ['Agent'] } })
  })

  it('takes commands from the default branch even when the worktree carries a different config', async () => {
    const worktreeConfig = JSON.stringify({ commands: { artifacts: 'node hijack.mjs' } })
    const load = createStageInstructionsLoader({ bundleRoot: ROOT, ops: pathOps, ...fakeFiles({ ...files, [`${WORKTREE}/.claude/port.config.json`]: worktreeConfig }), git: fakeGit(defaultBranchConfig) })
    const result = await load(launchRequest(), WORKTREE)
    const text = result.ok ? result.text : ''
    expect(text).toContain('commands.artifacts: node default.mjs')
    expect(text).not.toContain('hijack')
  })

  it('fails, naming the file, when the bundled agent file is missing', async () => {
    const load = createStageInstructionsLoader({ bundleRoot: ROOT, ops: pathOps, ...fakeFiles({}), git: fakeGit(defaultBranchConfig) })
    const result = await load(launchRequest(), WORKTREE)
    expect(result.ok ? '' : result.message).toContain('impl-agent.md')
  })

  it('fails on a missing PIPELINE.md section without blaming an install', async () => {
    const load = createStageInstructionsLoader({ bundleRoot: ROOT, ops: pathOps, ...fakeFiles({ ...files, [`${ROOT}/docs/PIPELINE.md`]: '## Quick start\nq\n' }), git: fakeGit(defaultBranchConfig) })
    const result = await load(launchRequest(), WORKTREE)
    expect(result.ok ? '' : result.message).toContain('has no "CLAUDE.md overrides" section')
    expect(result.ok ? '' : result.message).not.toContain('out of date')
  })

  it('refuses a bundle root inside the stage worktree', async () => {
    const inside = `${WORKTREE}/stage-prompts`
    const load = createStageInstructionsLoader({ bundleRoot: inside, ops: pathOps, ...fakeFiles({}), git: fakeGit(defaultBranchConfig) })
    const result = await load(launchRequest(), WORKTREE)
    expect(result.ok ? '' : result.message).toContain('inside the stage worktree')
  })

  it('fails when the default branch has no config', async () => {
    const load = createStageInstructionsLoader({ bundleRoot: ROOT, ops: pathOps, ...fakeFiles(files), git: fakeGit(null) })
    const result = await load(launchRequest(), WORKTREE)
    expect(result).toMatchObject({ ok: false })
  })

  it('reads the bundle through the default file reader', async () => {
    const bundle = join(await makeTempDir('port-stage-bundle-'), 'stage-prompts')
    await mkdir(join(bundle, 'agents'), { recursive: true })
    await mkdir(join(bundle, 'docs'), { recursive: true })
    await writeFile(join(bundle, 'agents', 'impl-agent.md'), '---\nname: impl-agent\ndescription: Implements a plan\n---\nYou are the Impl agent.', 'utf8')
    await writeFile(join(bundle, 'docs', 'PIPELINE.md'), files[`${ROOT}/docs/PIPELINE.md`], 'utf8')
    const real = createStageInstructionsLoader({ bundleRoot: bundle, ops: pathOps, readTextFile, git: fakeGit(defaultBranchConfig) })
    const result = await real(launchRequest(), WORKTREE)
    expect(result.ok).toBe(true)
    expect(result.ok ? result.text : '').toContain('You are the Impl agent.')
  })
})
