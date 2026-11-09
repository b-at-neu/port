import { readTextFile } from '@/main/platform/files'
import { defaultGitRunner } from '@/main/platform/git'
import { pathOps } from '@/main/platform/paths'
import { readAtDefaultRef } from '@/main/registry/harness'
import { loadStageAgentDefinition } from '@/main/stage/bundle'
import type { StageLaunchRequest } from '@/types/dispatch'
import type { FileResult, GitRunner, PathOps } from '@/types/platform'
import type { StageInstructionsLoader, StageInstructionsResult } from '@/types/stage'
import type { StageAgent } from '@/types/tick'
import { LABEL_KEYS, labelName } from '@/utils/labels/vocabulary'
import { KIND_PROMPT_NAMES, composeStagePrompt, stageModeOf } from '@/utils/stage/prompt'

/** Every agent file is told to follow these `PIPELINE.md` sections, so they travel with its body. */
export const STAGE_PIPELINE_SECTIONS = ['CLAUDE.md overrides', 'Operating rules (all stage agents)', 'Label lifecycle'] as const

const PLUGIN_ROOT_VARIABLE = '${CLAUDE_PLUGIN_ROOT}'

type ReadTextFile = (path: string) => Promise<FileResult<string>>
type PathReader = Pick<PathOps, 'join' | 'contains' | 'toPosix'>

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

export interface LoadStageInstructionsParams {
  readonly pluginRoot: string
  readonly agent: StageAgent
  readonly ops: PathReader
  readonly readTextFile: ReadTextFile
}

export async function loadStageInstructions(params: LoadStageInstructionsParams): Promise<StageInstructionsResult> {
  const agentFile = params.ops.join(params.pluginRoot, 'agents', `${params.agent}-agent.md`)
  const agent = await params.readTextFile(agentFile)
  if (!agent.ok) return { ok: false, message: `couldn't read ${agentFile}: ${agent.message}` }
  const pipelineFile = params.ops.join(params.pluginRoot, 'docs', 'PIPELINE.md')
  const pipeline = await params.readTextFile(pipelineFile)
  if (!pipeline.ok) return { ok: false, message: `couldn't read ${pipelineFile}: ${pipeline.message}` }

  const body = stripFrontmatter(agent.value.replaceAll('\r\n', '\n'))
  const pipelineText = pipeline.value.replaceAll('\r\n', '\n')
  const sections: string[] = []
  for (const title of STAGE_PIPELINE_SECTIONS) {
    const section = extractSection(pipelineText, title)
    if (section === null) return { ok: false, message: `${pipelineFile} has no "${title}" section` }
    sections.push(withoutDuplicateBlocks(section, body).replace(/\n{3,}/g, '\n\n').trim())
  }
  const text = [body, ...sections].join('\n\n').replaceAll(PLUGIN_ROOT_VARIABLE, params.ops.toPosix(params.pluginRoot))
  return { ok: true, text }
}

interface StageConfigFile {
  readonly docs?: { readonly engineering?: string | null; readonly design?: string | null }
  readonly commands?: Readonly<Record<string, unknown>>
}

export type StageConfigPointers =
  | { readonly ok: true; readonly docs: Readonly<Record<'engineering' | 'design', string | null>>; readonly commands: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly message: string }

const STAGE_CONFIG_PATH = '.claude/port.config.json'

function parseStageConfig(text: string): StageConfigFile | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** `commands.*` stays schema-only: it is read from the default branch's config, never from the stage worktree, whose checkout a pull request can edit. */
export async function readStageConfigPointers(root: string, git: GitRunner): Promise<StageConfigPointers> {
  const read = await readAtDefaultRef(git, root, STAGE_CONFIG_PATH)
  if (!read.ok) return { ok: false, message: `couldn't read ${STAGE_CONFIG_PATH} on the default branch: ${read.message}` }
  const config = parseStageConfig(read.text)
  if (config === null) return { ok: false, message: `${STAGE_CONFIG_PATH} on the default branch is not a JSON object` }
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
    ['mode', stageModeOf(request.trigger) ?? 'unknown'],
    [`models.${request.agent}`, request.model],
    ['plugin-root', pluginRoot],
    ['repo', config.repo],
    ['branches.integration', config.branches.integration],
    ['branches.production', config.branches.production ?? 'null'],
  ]
  for (const key of LABEL_KEYS) {
    const name = labelName(config.vocabulary, key)
    if (name !== undefined) context.push([`labels.${key}`, name])
  }
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

export interface StageInstructionsLoaderDeps {
  /** The app's own `stage-prompts` folder. */
  readonly bundleRoot: string
  readonly ops: PathReader
  readonly readTextFile: ReadTextFile
  readonly git: GitRunner
}

export function defaultStageInstructionsLoader(bundleRoot: string): StageInstructionsLoader {
  return createStageInstructionsLoader({ bundleRoot, ops: pathOps, readTextFile, git: defaultGitRunner() })
}

export function createStageInstructionsLoader(deps: StageInstructionsLoaderDeps): StageInstructionsLoader {
  return async (request, worktreePath) => {
    if (deps.ops.contains(worktreePath, deps.bundleRoot)) return { ok: false, message: `the bundled stage prompts at ${deps.bundleRoot} are inside the stage worktree` }
    const definition = await loadStageAgentDefinition({ root: deps.bundleRoot, agent: request.agent, ops: deps.ops, readTextFile: deps.readTextFile })
    if (!definition.ok) return definition
    const instructions = await loadStageInstructions({ pluginRoot: deps.bundleRoot, agent: request.agent, ops: deps.ops, readTextFile: deps.readTextFile })
    if (!instructions.ok) return instructions
    const pointers = await readStageConfigPointers(request.entry.path, deps.git)
    if (!pointers.ok) return pointers
    const root = deps.ops.toPosix(deps.bundleRoot)
    const text = composeStagePrompt({ header: request.prompt, context: buildStageContext(request, root, pointers), instructions: instructions.text, source: root })
    return { ok: true, text, agent: { name: definition.name, definition: definition.definition } }
  }
}
