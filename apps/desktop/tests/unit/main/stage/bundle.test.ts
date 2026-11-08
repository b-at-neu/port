import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readTextFile } from '@/main/platform/files'
import { pathOps } from '@/main/platform/paths'
import { loadStageAgentDefinition, stageBundleRoot } from '@/main/stage/bundle'
import { extractSection, STAGE_PIPELINE_SECTIONS } from '@/main/stage/instructions'
import type { FileResult } from '@/types/platform'
import type { StageAgent } from '@/types/tick'

const ROOT = '/bundle'

function load(file: string | null, agent: StageAgent = 'impl') {
  const readFake = (path: string): Promise<FileResult<string>> => Promise.resolve(file === null ? { ok: false, kind: 'not-found', message: `ENOENT ${path}` } : { ok: true, value: file })
  return loadStageAgentDefinition({ root: ROOT, agent, ops: pathOps, readTextFile: readFake })
}

describe('stageBundleRoot', () => {
  it('is the app resources folder when packaged', () => {
    expect(stageBundleRoot({ isPackaged: true, mainDir: '/app/out/main', resourcesPath: '/app/resources' })).toBe(join('/app/resources', 'stage-prompts'))
  })

  it('is the desktop package folder in development', () => {
    expect(stageBundleRoot({ isPackaged: false, mainDir: '/repo/apps/desktop/out/main', resourcesPath: '/ignored' })).toBe(join('/repo/apps/desktop', 'stage-prompts'))
  })
})

describe('loadStageAgentDefinition', () => {
  it('splits the frontmatter from the body and reads the tool lists', async () => {
    const result = await load('---\nname: impl-agent\ndescription: Implements a plan\ntools: Read, Edit,, Bash\ndisallowedTools: Agent\nmodel: sonnet\n---\n\nYou are the Impl agent.\n')
    expect(result).toEqual({ ok: true, name: 'impl-agent', definition: { description: 'Implements a plan', prompt: 'You are the Impl agent.', tools: ['Read', 'Edit', 'Bash'], disallowedTools: ['Agent'] } })
  })

  it('omits the tool lists the file does not declare', async () => {
    const result = await load('---\nname: plan-agent\ndescription: Plans\n---\nBody')
    expect(result).toEqual({ ok: true, name: 'plan-agent', definition: { description: 'Plans', prompt: 'Body' } })
  })

  it('reads a CRLF file the same way', async () => {
    const result = await load('---\r\nname: plan-agent\r\ndescription: Plans\r\n---\r\nBody\r\n')
    expect(result).toEqual({ ok: true, name: 'plan-agent', definition: { description: 'Plans', prompt: 'Body' } })
  })

  it.each([
    ['name', '---\ndescription: Plans\n---\nBody'],
    ['description', '---\nname: plan-agent\n---\nBody'],
    ['frontmatter', 'Body only'],
  ])('fails naming the file when the %s is missing', async (_what, text) => {
    const result = await load(text)
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.message).toContain(pathOps.join(ROOT, 'agents', 'impl-agent.md'))
  })

  it('fails naming the file when it cannot be read', async () => {
    const result = await load(null)
    expect(result.ok ? '' : result.message).toContain('impl-agent.md')
  })
})

describe('the real bundled stage prompts', () => {
  const REAL_ROOT = join(__dirname, '../../../../stage-prompts')

  it.each<StageAgent>(['plan', 'impl', 'review', 'revise'])('loads the %s agent', async (agent) => {
    const result = await loadStageAgentDefinition({ root: REAL_ROOT, agent, ops: pathOps, readTextFile })
    expect(result.ok).toBe(true)
    expect(result.ok ? result.name : '').toBe(`${agent}-agent`)
    expect(result.ok ? result.definition.prompt.length : 0).toBeGreaterThan(0)
  })

  it('carries every PIPELINE.md section the agents are told to follow, plus the two other docs', async () => {
    const pipeline = await readTextFile(join(REAL_ROOT, 'docs', 'PIPELINE.md'))
    expect(pipeline.ok).toBe(true)
    for (const title of STAGE_PIPELINE_SECTIONS) expect(extractSection(pipeline.ok ? pipeline.value : '', title)).not.toBeNull()
    for (const file of ['FORMATS.md', 'RECOVERY.md']) expect((await readTextFile(join(REAL_ROOT, 'docs', file))).ok).toBe(true)
  })
})
