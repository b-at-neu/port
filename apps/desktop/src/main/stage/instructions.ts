import { readJsonFile, readTextFile } from '@/main/platform/files'
import { pathOps } from '@/main/platform/paths'
import { defaultClaudeHome } from '@/main/sessions/locate'
import type { StageLaunchRequest } from '@/types/dispatch'
import type { FileResult, PathOps } from '@/types/platform'
import type { StageInstructionsLoader, StageInstructionsResult } from '@/types/stage'
import type { StageAgent } from '@/types/tick'
import { LABEL_KEYS, labelName } from '@/utils/labels/vocabulary'
import { KIND_PROMPT_NAMES, composeStagePrompt, stageModeOf } from '@/utils/stage/prompt'

/** Every agent file is told to follow these `PIPELINE.md` sections, so they travel with its body. */
export const STAGE_PIPELINE_SECTIONS = ['CLAUDE.md overrides', 'Operating rules (all stage agents)', 'Label lifecycle'] as const

const PLUGIN_KEY = 'port@port'
const PLUGIN_ROOT_VARIABLE = '${CLAUDE_PLUGIN_ROOT}'

interface InstallRecord {
  readonly scope?: string
  readonly projectPath?: string
  readonly installPath?: string
}

interface InstalledPlugins {
  readonly plugins?: Readonly<Record<string, readonly InstallRecord[]>>
}

type ReadJsonFile = <T>(path: string) => Promise<FileResult<T>>
type ReadTextFile = (path: string) => Promise<FileResult<string>>
type PathReader = Pick<PathOps, 'join' | 'samePath' | 'contains' | 'toPosix'>

export type PluginRootResult = { readonly ok: true; readonly root: string } | { readonly ok: false; readonly message: string }

export interface ResolveInstalledPluginRootParams {
  readonly claudeHome: string
  readonly repoRoot: string
  readonly worktree: string
  readonly ops: PathReader
  readonly readJsonFile: ReadJsonFile
}

/** Prefers the install scoped to this repository, then a project install, then the user one — never a path inside the stage worktree. */
export async function resolveInstalledPluginRoot(params: ResolveInstalledPluginRootParams): Promise<PluginRootResult> {
  const file = params.ops.join(params.claudeHome, 'plugins', 'installed_plugins.json')
  const read = await params.readJsonFile<InstalledPlugins>(file)
  if (!read.ok) return { ok: false, message: `couldn't read ${file}: ${read.message}` }

  const records = (read.value.plugins?.[PLUGIN_KEY] ?? []).filter((record) => typeof record.installPath === 'string' && record.installPath !== '')
  const forRepo = (scope: string) => records.find((record) => record.scope === scope && record.projectPath !== undefined && params.ops.samePath(record.projectPath, params.repoRoot))
  const chosen = forRepo('local') ?? forRepo('project') ?? records.find((record) => record.scope === 'user')
  if (chosen?.installPath === undefined) return { ok: false, message: `no ${PLUGIN_KEY} install record in ${file}` }
  if (params.ops.contains(params.worktree, chosen.installPath)) return { ok: false, message: `the ${PLUGIN_KEY} install path ${chosen.installPath} is inside the stage worktree` }
  return { ok: true, root: chosen.installPath }
}

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

/** `commands.*` stays schema-only: it is read from the worktree's own config file, never from `CLAUDE.md`. */
export async function readStageConfigPointers(worktree: string, ops: Pick<PathOps, 'join'>, readJsonFile: ReadJsonFile): Promise<StageConfigPointers> {
  const file = ops.join(worktree, '.claude', 'port.config.json')
  const read = await readJsonFile<StageConfigFile>(file)
  if (!read.ok) return { ok: false, message: `couldn't read ${file}: ${read.message}` }
  const commands: Record<string, string> = {}
  for (const [key, value] of Object.entries(read.value.commands ?? {})) {
    if (value === null || value === undefined) continue
    commands[key] = typeof value === 'string' ? value : JSON.stringify(value)
  }
  return { ok: true, docs: { engineering: read.value.docs?.engineering ?? null, design: read.value.docs?.design ?? null }, commands }
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
  context.push(['docs.engineering', pointers.docs.engineering ?? 'null'], ['docs.design', pointers.docs.design ?? 'null'])
  for (const [key, value] of Object.entries(pointers.commands)) context.push([`commands.${key}`, value])
  for (const applied of config.overrides) context.push(['override', oneLine(`${applied.path} = ${JSON.stringify(applied.value)} (${applied.reason})`)])
  for (const diagnostic of diagnostics) {
    if (diagnostic.kind === 'override-refused') context.push(['override-refused', oneLine(`${diagnostic.path ?? 'block'}: ${diagnostic.reason}`)])
  }
  return context
}

export interface StageInstructionsLoaderDeps {
  readonly claudeHome: string
  readonly ops: PathReader
  readonly readTextFile: ReadTextFile
  readonly readJsonFile: ReadJsonFile
}

export function defaultStageInstructionsLoader(): StageInstructionsLoader {
  return createStageInstructionsLoader({ claudeHome: defaultClaudeHome(), ops: pathOps, readTextFile, readJsonFile })
}

export function createStageInstructionsLoader(deps: StageInstructionsLoaderDeps): StageInstructionsLoader {
  return async (request, worktreePath) => {
    const resolved = await resolveInstalledPluginRoot({ claudeHome: deps.claudeHome, repoRoot: request.entry.path, worktree: worktreePath, ops: deps.ops, readJsonFile: deps.readJsonFile })
    if (!resolved.ok) return resolved
    const instructions = await loadStageInstructions({ pluginRoot: resolved.root, agent: request.agent, ops: deps.ops, readTextFile: deps.readTextFile })
    if (!instructions.ok) return instructions
    const pointers = await readStageConfigPointers(worktreePath, deps.ops, deps.readJsonFile)
    if (!pointers.ok) return pointers
    const pluginRoot = deps.ops.toPosix(resolved.root)
    return { ok: true, text: composeStagePrompt({ header: request.prompt, context: buildStageContext(request, pluginRoot, pointers), instructions: instructions.text, source: pluginRoot }) }
  }
}
