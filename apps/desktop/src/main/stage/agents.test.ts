import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { STAGE_AGENT_NAMES } from './agents'

const PLUGIN_ROOT = join(__dirname, '../../../../../plugins/port')

async function frontmatterName(file: string): Promise<string> {
  const text = await readFile(join(PLUGIN_ROOT, 'agents', file), 'utf8')
  const match = /^name:\s*(\S+)/m.exec(text)
  if (match?.[1] === undefined) throw new Error(`${file} has no 'name:' frontmatter field`)
  return match[1]
}

describe('STAGE_AGENT_NAMES', () => {
  it('pins every StageAgent to its agent file frontmatter name, namespaced by the plugin', async () => {
    const files: Record<keyof typeof STAGE_AGENT_NAMES, string> = {
      plan: 'plan-agent.md',
      impl: 'impl-agent.md',
      review: 'review-agent.md',
      revise: 'revise-agent.md',
    }
    for (const [stage, file] of Object.entries(files) as [keyof typeof STAGE_AGENT_NAMES, string][]) {
      expect(STAGE_AGENT_NAMES[stage]).toBe(`port:${await frontmatterName(file)}`)
    }
  })

  it('names exactly the four stage agents, nothing more', () => {
    expect(Object.keys(STAGE_AGENT_NAMES).sort()).toEqual(['impl', 'plan', 'review', 'revise'])
  })
})
