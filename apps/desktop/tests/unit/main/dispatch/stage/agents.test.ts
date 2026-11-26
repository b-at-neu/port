import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DISPATCH_PROMPT, REFRESH_PROMPT } from '@/main/dispatch/launch'
import { HANDBACK_TOKENS } from '@/main/pipeline/transitions'
import { STAGE_AGENT_NAMES } from '@/main/dispatch/stage/agents'
import { BLOCKED_PREFIX, HANDBACK_PREFIX, QUESTIONS_PREFIX } from '@/utils/stage/handback-text'

const BUNDLE_ROOT = join(__dirname, '../../../../../stage-prompts')

async function frontmatterName(file: string): Promise<string> {
  const text = await readFile(join(BUNDLE_ROOT, 'agents', file), 'utf8')
  const match = /^name:\s*(\S+)/m.exec(text)
  if (match?.[1] === undefined) throw new Error(`${file} has no 'name:' frontmatter field`)
  return match[1]
}

describe('STAGE_AGENT_NAMES', () => {
  it('pins every StageAgent to its bundled agent file frontmatter name', async () => {
    const files: Record<keyof typeof STAGE_AGENT_NAMES, string> = {
      plan: 'plan-agent.md',
      impl: 'impl-agent.md',
      review: 'review-agent.md',
      revise: 'revise-agent.md',
    }
    for (const [stage, file] of Object.entries(files) as [keyof typeof STAGE_AGENT_NAMES, string][]) {
      expect(STAGE_AGENT_NAMES[stage]).toBe(await frontmatterName(file))
    }
  })

  it('names exactly the four stage agents, nothing more', () => {
    expect(Object.keys(STAGE_AGENT_NAMES).sort()).toEqual(['impl', 'plan', 'review', 'revise'])
  })
})

const STAGES = ['plan', 'impl', 'review', 'revise'] as const
const LABEL_WRITING_NEEDLES = ['--add-label', '--remove-label', 'label-cas', '<labels.', '--label', 'gh issue edit']

describe('bundled stage agents', () => {
  const textOf = (stage: string): Promise<string> => readFile(join(BUNDLE_ROOT, 'agents', `${stage}-agent.md`), 'utf8')
  const handbackTokensIn = (text: string): Set<string> => new Set([...text.matchAll(/HANDBACK:\s+([a-z][a-z-]*)/g)].map((m) => m[1] ?? ''))

  it.each(STAGES)('%s agent has every step DISPATCH_PROMPT names, and no label swap', async (stage) => {
    const steps = /Follow your (.+?) steps exactly/.exec(DISPATCH_PROMPT)?.[1]?.split(/,\s*(?:and\s+)?/) ?? []
    const text = await textOf(stage)
    expect(steps.length).toBeGreaterThan(0)
    for (const step of steps) expect(text).toMatch(new RegExp(`^## ${step}\\b`, 'm'))
    expect(text).not.toMatch(/^## Label swap/m)
  })

  it('revise agent has the refresh section REFRESH_PROMPT names', async () => {
    expect(REFRESH_PROMPT).toContain('refresh mode')
    expect(await textOf('revise')).toMatch(/^## Refresh mode$/m)
  })

  it.each(STAGES)('%s agent names exactly the HANDBACK tokens the transition table accepts', async (stage) => {
    const accepted = stage === 'revise' ? new Set([...HANDBACK_TOKENS.revise, ...HANDBACK_TOKENS.refresh]) : new Set(HANDBACK_TOKENS[stage])
    expect(handbackTokensIn(await textOf(stage))).toEqual(accepted)
  })

  it.each(STAGES)('%s agent names HANDBACK, and none writes a label', async (stage) => {
    const text = await textOf(stage)
    expect(text).toContain(HANDBACK_PREFIX)
    for (const needle of LABEL_WRITING_NEEDLES) expect(text).not.toContain(needle)
  })

  it('every agent carries impl-agent\'s "Dispatched with a stage context" paragraph', async () => {
    const paragraphOf = (text: string): string | null => {
      const start = text.indexOf('**Dispatched with a stage context.**')
      return start === -1 ? null : text.slice(start, text.indexOf('\n', start))
    }
    const canonical = paragraphOf(await textOf('impl'))
    expect(canonical).not.toBeNull()
    for (const stage of STAGES) expect(paragraphOf(await textOf(stage))).toBe(canonical)
  })

  it('names the questions and blocked prefixes somewhere across the four', async () => {
    const all = (await Promise.all(STAGES.map(textOf))).join('\n')
    expect(all).toContain(QUESTIONS_PREFIX)
    expect(all).toContain(BLOCKED_PREFIX)
  })
})
