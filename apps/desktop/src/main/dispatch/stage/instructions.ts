import type { Platform } from '@/main/platform'
import { pathOps } from '@/main/platform/paths'
import { readAtDefaultRef } from '@/main/repos/config/harness'
import { CONFIG_PATH } from '@/main/repos/config/paths'
import { loadStageAgentDefinition } from '@/main/dispatch/stage/bundle'
import type { StageLaunchRequest } from '@/types/dispatch'
import type { StageInstructionsResult, StageLoadedInstructions } from '@/types/stage'
import type { StageAgent } from '@/types/tick'
import { KIND_PROMPT_NAMES, composeStageSystemPrompt } from '@/utils/stage/prompt'

/** Every agent file is told to follow these `PIPELINE.md` sections, so they travel with its body. */
export const STAGE_PIPELINE_SECTIONS = ['CLAUDE.md overrides', 'Operating rules (all stage agents)', 'Hand-back line'] as const

const PLUGIN_ROOT_VARIABLE = '${CLAUDE_PLUGIN_ROOT}'

function stripFrontmatter(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n/, '').trim()
}

/** A section runs from its heading to the next heading of the same or higher level; fenced lines never count as headings. */
export function extractSection(markdown: string, title: string): string | null {
  const lines = markdown.split('\n')
  let fenced = false
  let start = -1
  let level = 0
  for (const [index, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    if (fenced) continue
    const heading = /^(#{1,6})\s+(.*?)\s*$/.exec(line)
    if (heading === null) continue
    const depth = heading[1]?.length ?? 0
    if (start === -1) {
      if (heading[2] === title) {
        start = index
        level = depth
      }
    } else if (depth <= level) {
      return lines.slice(start, index).join('\n').trimEnd()
    }
  }
  return start === -1 ? null : lines.slice(start).join('\n').trimEnd()
}

const MARKER_BLOCK = /<!-- ([\w-]+):begin -->[\s\S]*?<!-- \1:end -->\n?/g

/** A marker block the agent body already carries is dropped, so nothing is sent twice. */
function withoutDuplicateBlocks(section: string, agentBody: string): string {
  return section.replace(MARKER_BLOCK, (block, name: string) => (agentBody.includes(`<!-- ${name}:begin -->`) ? '' : block))
}

export async function loadStageInstructions(ctx: Pick<Platform, 'fs'>, pluginRoot: string, agentName: StageAgent): Promise<StageInstructionsResult> {
  const agentFile = pathOps.join(pluginRoot, 'agents', `${agentName}-agent.md`)
  const agent = await ctx.fs.readText(agentFile)
  if (!agent.ok) return { ok: false, message: `couldn't read ${agentFile}: ${agent.message}` }
  const pipelineFile = pathOps.join(pluginRoot, 'docs', 'PIPELINE.md')
  const pipeline = await ctx.fs.readText(pipelineFile)
  if (!pipeline.ok) return { ok: false, message: `couldn't read ${pipelineFile}: ${pipeline.message}` }

  const body = stripFrontmatter(agent.value.replaceAll('\r\n', '\n'))
  const pipelineText = pipeline.value.replaceAll('\r\n', '\n')
  const sections: string[] = []
  for (const title of STAGE_PIPELINE_SECTIONS) {
    const section = extractSection(pipelineText, title)
    if (section === null) return { ok: false, message: `${pipelineFile} has no "${title}" section` }
    sections.push(withoutDuplicateBlocks(section, body).replace(/\n{3,}/g, '\n\n').trim())
  }
  const text = [body, ...sections].join('\n\n').replaceAll(PLUGIN_ROOT_VARIABLE, pathOps.toPosix(pluginRoot))
  return { ok: true, text }
}

interface StageConfigFile {
  readonly docs?: { readonly engineering?: string | null; readonly design?: string | null }
  readonly commands?: Readonly<Record<string, unknown>>
}

export type StageConfigPointers =
  | { readonly ok: true; readonly docs: Readonly<Record<'engineering' | 'design', string | null>>; readonly commands: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly message: string }


function parseStageConfig(text: string): StageConfigFile | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** `commands.*` stays schema-only: it is read from the default branch's config, never from the stage worktree, whose checkout a pull request can edit. */
export async function readStageConfigPointers(ctx: Pick<Platform, 'git'>, root: string): Promise<StageConfigPointers> {
  const read = await readAtDefaultRef(ctx, root, CONFIG_PATH)
  if (!read.ok) return { ok: false, message: `couldn't read ${CONFIG_PATH} on the default branch: ${read.message}` }
  const config = parseStageConfig(read.text)
  if (config === null) return { ok: false, message: `${CONFIG_PATH} on the default branch is not a JSON object` }
  const commands: Record<string, string> = {}
  for (const [key, value] of Object.entries(config.commands ?? {})) {
    if (value === null || value === undefined) continue
    commands[key] = typeof value === 'string' ? value : JSON.stringify(value)
  }
  return { ok: true, docs: { engineering: config.docs?.engineering ?? null, design: config.docs?.design ?? null }, commands }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function buildStageContext(request: StageLaunchRequest, pluginRoot: string, pointers: Extract<StageConfigPointers, { readonly ok: true }>): readonly (readonly [string, string])[] {
  const { config, diagnostics } = request.entry
  const context: [string, string][] = [
    ['stage', request.agent],
    ['item', `${KIND_PROMPT_NAMES[request.kind]} #${String(request.number)}`],
    ['mode', request.mode],
    [`models.${request.agent}`, request.model],
    ['plugin-root', pluginRoot],
    ['repo', config.repo],
    ['branches.integration', config.branches.integration],
    ['branches.production', config.branches.production ?? 'null'],
  ]
  for (const [key, enabled] of Object.entries(config.modules)) context.push([`modules.${key}`, String(enabled)])
  context.push(['sessionRequiredPaths', JSON.stringify(config.sessionRequiredPaths)], ['reviewCycleCap', String(config.reviewCycleCap)])
  if (request.review !== null) context.push(['review.cycle', String(request.review.cycle)], ['review.selfAuthored', String(request.review.selfAuthored)])
  context.push(['docs.engineering', pointers.docs.engineering ?? 'null'], ['docs.design', pointers.docs.design ?? 'null'])
  for (const [key, value] of Object.entries(pointers.commands)) context.push([`commands.${key}`, value])
  for (const applied of config.overrides) context.push(['override', oneLine(`${applied.path} = ${JSON.stringify(applied.value)} (${applied.reason})`)])
  for (const diagnostic of diagnostics) {
    if (diagnostic.kind === 'override-refused') context.push(['override-refused', oneLine(`${diagnostic.path ?? 'block'}: ${diagnostic.reason}`)])
  }
  return context
}

/** The first message — only the dispatch line — and the inline agent, whose system prompt carries the stage context and the bundled instructions. */
export async function loadStageLaunch(ctx: Pick<Platform, 'fs' | 'git'>, bundleRoot: string, request: StageLaunchRequest, worktreePath: string): Promise<StageLoadedInstructions> {
  if (pathOps.contains(worktreePath, bundleRoot)) return { ok: false, message: `the bundled stage prompts at ${bundleRoot} are inside the stage worktree` }
  const instructions = await loadStageInstructions(ctx, bundleRoot, request.agent)
  if (!instructions.ok) return instructions
  const pointers = await readStageConfigPointers(ctx, request.entry.path)
  if (!pointers.ok) return pointers
  const root = pathOps.toPosix(bundleRoot)
  const prompt = composeStageSystemPrompt({ context: buildStageContext(request, root, pointers), instructions: instructions.text, source: root })
  const definition = await loadStageAgentDefinition(ctx, { root: bundleRoot, agent: request.agent, prompt })
  if (!definition.ok) return definition
  return { ok: true, text: request.prompt, agent: { name: definition.name, definition: definition.definition, selfContained: true } }
}
