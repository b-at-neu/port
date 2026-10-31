import { readJsonFile, readTextFile } from '@/main/platform/files'
import { defaultGitRunner } from '@/main/platform/git'
import { pathOps } from '@/main/platform/paths'
import { readAtDefaultRef } from '@/main/registry/harness'
import { defaultClaudeHome } from '@/main/sessions/locate'
import type { StageLaunchRequest } from '@/types/dispatch'
import type { FileResult, GitRunner, PathOps } from '@/types/platform'
import type { StageInstructionsLoader, StageInstructionsResult } from '@/types/stage'
import type { StageAgent } from '@/types/tick'
import { LABEL_KEYS, labelName } from '@/utils/labels/vocabulary'
import { KIND_PROMPT_NAMES, composeStagePrompt, stageModeOf } from '@/utils/stage/prompt'

/** Every agent file is told to follow these `PIPELINE.md` sections, so they travel with its body. */
export const STAGE_PIPELINE_SECTIONS = ['CLAUDE.md overrides', 'Operating rules (all stage agents)', 'Label lifecycle'] as const

const PLUGIN_NAME = 'port'
const MARKETPLACE = 'port'
const PLUGIN_KEY = `${PLUGIN_NAME}@${MARKETPLACE}`
const PLUGIN_ROOT_VARIABLE = '${CLAUDE_PLUGIN_ROOT}'

interface InstallRecord {
  readonly scope?: string
  readonly projectPath?: string
  readonly installPath?: string
  readonly version?: string
}

interface KnownMarketplaces {
  readonly [marketplace: string]: { readonly source?: { readonly source?: unknown; readonly path?: unknown }; readonly installLocation?: unknown } | undefined
}

interface MarketplaceManifest {
  readonly plugins?: readonly { readonly name?: unknown; readonly source?: unknown }[]
}

interface InstalledPlugins {
  readonly plugins?: Readonly<Record<string, readonly InstallRecord[]>>
}

type ReadJsonFile = <T>(path: string) => Promise<FileResult<T>>
type ReadTextFile = (path: string) => Promise<FileResult<string>>
type PathReader = Pick<PathOps, 'join' | 'samePath' | 'contains' | 'toPosix' | 'resolveFrom'>

export type PluginRootResult =
  | { readonly ok: true; readonly root: string; readonly origin: 'directory' | 'install-record'; readonly version: string | null }
  | { readonly ok: false; readonly message: string }

type LiveDirectoryRoot = { readonly kind: 'live'; readonly root: string } | { readonly kind: 'not-directory' } | { readonly kind: 'failed'; readonly message: string }

/** A directory-source marketplace is read live, the way the CLI reads it, so a frozen install path can never go stale. */
async function resolveLiveDirectoryRoot(claudeHome: string, ops: PathReader, readJsonFile: ReadJsonFile): Promise<LiveDirectoryRoot> {
  const known = await readJsonFile<KnownMarketplaces>(ops.join(claudeHome, 'plugins', 'known_marketplaces.json'))
  if (!known.ok) return { kind: 'not-directory' }
  const entry = known.value[MARKETPLACE]
  if (entry?.source?.source !== 'directory') return { kind: 'not-directory' }
  const dir = [entry.source.path, entry.installLocation].find((value): value is string => typeof value === 'string' && value !== '')
  if (dir === undefined) return { kind: 'failed', message: `the ${MARKETPLACE} marketplace in known_marketplaces.json has no directory path` }
  const manifestFile = ops.join(dir, '.claude-plugin', 'marketplace.json')
  const manifest = await readJsonFile<MarketplaceManifest>(manifestFile)
  if (!manifest.ok) return { kind: 'failed', message: `couldn't read ${manifestFile}: ${manifest.message}` }
  const source = manifest.value.plugins?.find((plugin) => plugin.name === PLUGIN_NAME)?.source
  if (typeof source !== 'string') return { kind: 'failed', message: `${manifestFile} has no ${PLUGIN_NAME} plugin with a directory source` }
  return { kind: 'live', root: ops.resolveFrom(dir, source) }
}

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
  const live = await resolveLiveDirectoryRoot(params.claudeHome, params.ops, params.readJsonFile)
  if (live.kind === 'failed') return { ok: false, message: live.message }
  const root = live.kind === 'live' ? live.root : chosen.installPath
  if (params.ops.contains(params.worktree, root)) return { ok: false, message: `the ${PLUGIN_KEY} install path ${root} is inside the stage worktree` }
  return { ok: true, root, origin: live.kind === 'live' ? 'directory' : 'install-record', version: chosen.version ?? null }
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
    if (section === null) return { ok: false, kind: 'missing-section', message: `${pipelineFile} has no "${title}" section` }
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
  readonly git: GitRunner
}

export function defaultStageInstructionsLoader(): StageInstructionsLoader {
  return createStageInstructionsLoader({ claudeHome: defaultClaudeHome(), ops: pathOps, readTextFile, readJsonFile, git: defaultGitRunner() })
}

export function createStageInstructionsLoader(deps: StageInstructionsLoaderDeps): StageInstructionsLoader {
  return async (request, worktreePath) => {
    const resolved = await resolveInstalledPluginRoot({ claudeHome: deps.claudeHome, repoRoot: request.entry.path, worktree: worktreePath, ops: deps.ops, readJsonFile: deps.readJsonFile })
    if (!resolved.ok) return resolved
    const instructions = await loadStageInstructions({ pluginRoot: resolved.root, agent: request.agent, ops: deps.ops, readTextFile: deps.readTextFile })
    if (!instructions.ok) {
      if (instructions.kind !== 'missing-section' || resolved.origin !== 'install-record') return instructions
      return { ok: false, message: `${instructions.message} — the ${PLUGIN_KEY} install at ${resolved.root} (version ${resolved.version ?? 'unknown'}) looks out of date. Update or reinstall the plugin, then the next dispatch picks it up.` }
    }
    const pointers = await readStageConfigPointers(request.entry.path, deps.git)
    if (!pointers.ok) return pointers
    const pluginRoot = deps.ops.toPosix(resolved.root)
    return { ok: true, text: composeStagePrompt({ header: request.prompt, context: buildStageContext(request, pluginRoot, pointers), instructions: instructions.text, source: pluginRoot }) }
  }
}
