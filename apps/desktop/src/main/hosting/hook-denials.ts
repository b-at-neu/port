// Pairs a `tool_use` with the guard hook's allowlist-miss `tool_result`, so a Bash call the hook denied before `canUseTool` ever ran still reaches a stage session's `onDeny`.

import { GUARD_ALLOWLIST_MISS_MARKER } from '@/main/hosting/guard-marker'
import { TOOL_USE_ID_FIELD } from '@/main/sessions/transcript-entries'

export interface HookDeniedCall {
  readonly toolName: string
  readonly input: Readonly<Record<string, unknown>>
}

export interface HookDenialTracker {
  /** Returns each call this message's results show the guard denied for an allowlist miss, once per call. */
  readonly observe: (message: unknown) => readonly HookDeniedCall[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function contentBlocksOf(message: unknown): readonly unknown[] {
  if (!isRecord(message) || !isRecord(message.message)) return []
  const content = message.message.content
  return Array.isArray(content) ? content : []
}

/** A tool result's content is either a plain string or an array of `text` blocks. */
function resultTextOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block) => (isRecord(block) && typeof block.text === 'string' ? block.text : '')).join('\n')
}

export function createHookDenialTracker(): HookDenialTracker {
  const calls = new Map<string, HookDeniedCall>()

  return {
    observe(message) {
      if (!isRecord(message)) return []
      if (message.type === 'assistant') {
        for (const block of contentBlocksOf(message)) {
          if (!isRecord(block) || block.type !== 'tool_use') continue
          if (typeof block.id !== 'string' || typeof block.name !== 'string') continue
          calls.set(block.id, { toolName: block.name, input: isRecord(block.input) ? block.input : {} })
        }
        return []
      }
      if (message.type !== 'user') return []
      const hits: HookDeniedCall[] = []
      for (const block of contentBlocksOf(message)) {
        if (!isRecord(block) || block.type !== 'tool_result') continue
        const id = block[TOOL_USE_ID_FIELD]
        if (typeof id !== 'string') continue
        const call = calls.get(id)
        if (call === undefined) continue
        calls.delete(id)
        if (block.is_error === true && resultTextOf(block.content).includes(GUARD_ALLOWLIST_MISS_MARKER)) hits.push(call)
      }
      return hits
    },
  }
}
