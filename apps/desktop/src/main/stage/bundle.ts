// Locates the app's own copy of the stage prompts and turns an agent file into an inline SDK agent definition — no `electron` import, so it is testable without a running app.
import { join } from 'node:path'
import type { FileResult, PathOps } from '@/types/platform'
import type { StageAgentDefinition, StageBundleRootInput } from '@/types/stage'
import type { StageAgent } from '@/types/tick'

export function stageBundleRoot(input: StageBundleRootInput): string {
  return input.isPackaged ? join(input.resourcesPath, 'stage-prompts') : join(input.mainDir, '../../stage-prompts')
}

interface LoadStageAgentDefinitionParams {
  readonly root: string
  readonly agent: StageAgent
  readonly ops: Pick<PathOps, 'join'>
  readonly readTextFile: (path: string) => Promise<FileResult<string>>
}

type StageAgentDefinitionResult =
  | { readonly ok: true; readonly name: string; readonly definition: StageAgentDefinition }
  | { readonly ok: false; readonly message: string }

function commaList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined
  const items = value.split(',').map((item) => item.trim()).filter((item) => item !== '')
  return items.length > 0 ? items : undefined
}

function parseFrontmatter(text: string): { readonly fields: ReadonlyMap<string, string>; readonly body: string } | null {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)
  if (match === null) return null
  const fields = new Map<string, string>()
  for (const line of (match[1] ?? '').split('\n')) {
    const split = /^([\w-]+):\s*(.*)$/.exec(line)
    if (split?.[1] !== undefined) fields.set(split[1], (split[2] ?? '').trim())
  }
  return { fields, body: (match[2] ?? '').trim() }
}

/** Never throws: a missing file or a frontmatter without `name`/`description` is a typed failure naming the file. */
export async function loadStageAgentDefinition(params: LoadStageAgentDefinitionParams): Promise<StageAgentDefinitionResult> {
  const file = params.ops.join(params.root, 'agents', `${params.agent}-agent.md`)
  const read = await params.readTextFile(file)
  if (!read.ok) return { ok: false, message: `couldn't read ${file}: ${read.message}` }
  const parsed = parseFrontmatter(read.value.replaceAll('\r\n', '\n'))
  const name = parsed?.fields.get('name')
  const description = parsed?.fields.get('description')
  if (parsed === null || name === undefined || name === '' || description === undefined || description === '') {
    return { ok: false, message: `${file} has no frontmatter with a name and a description` }
  }
  const tools = commaList(parsed.fields.get('tools'))
  const disallowedTools = commaList(parsed.fields.get('disallowedTools'))
  return {
    ok: true,
    name,
    definition: { description, prompt: parsed.body, ...(tools !== undefined ? { tools } : {}), ...(disallowedTools !== undefined ? { disallowedTools } : {}) },
  }
}
