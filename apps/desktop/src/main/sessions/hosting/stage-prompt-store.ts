import type { PlatformFs } from '@/types/platform'
import { pathOps } from '@/main/platform/paths'

type PromptFs = Pick<PlatformFs, 'readText' | 'writeText' | 'ensureDir'>

const SESSION_ID = /^[\w-]+$/

/** The folder under the app's data directory that holds each stage session's system prompt. */
export function stagePromptsDir(userData: string): string {
  return pathOps.join(userData, 'stage-prompts')
}

function fileOf(dir: string, sessionId: string): string | null {
  return SESSION_ID.test(sessionId) ? pathOps.join(dir, `${sessionId}.md`) : null
}

/** An id that is not a plain identifier, a missing file and an unreadable file all read as `null`, which callers treat as a session that predates the saved prompt. */
export async function readStagePrompt(fs: Pick<PromptFs, 'readText'>, dir: string, sessionId: string): Promise<string | null> {
  const file = fileOf(dir, sessionId)
  if (file === null) return null
  const read = await fs.readText(file)
  return read.ok && read.value !== '' ? read.value : null
}

/** Resolves to a failure message, or `null` once written; never throws. */
export async function writeStagePrompt(fs: PromptFs, dir: string, sessionId: string, text: string): Promise<string | null> {
  const file = fileOf(dir, sessionId)
  if (file === null) return `session id ${sessionId} is not a valid file name`
  const ensured = await fs.ensureDir(dir)
  if (!ensured.ok) return ensured.message
  const written = await fs.writeText(file, text)
  return written.ok ? null : written.message
}
