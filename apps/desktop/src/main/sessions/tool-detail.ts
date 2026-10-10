// Pure per-tool detail derivation — never throws, every string sanitized and capped by the caller.
import type { ToolDetail } from '../../shared/sessions/transcript'
import { isRecord } from '../../shared/guards'

const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed'])

function exitCodeFromError(text: string): number | null {
  const match = /^Exit code (\d+)/m.exec(text)
  if (match?.[1] === undefined) return null
  const parsed = Number(match[1])
  return Number.isFinite(parsed) ? parsed : null
}

function resultTextOf(result: unknown): string {
  if (typeof result === 'string') return result
  if (!isRecord(result)) return ''
  const content = result['content']
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is Record<string, unknown> => isRecord(block))
    .map((block) => (typeof block['text'] === 'string' ? block['text'] : ''))
    .join('\n')
}

function bashDetail(input: Record<string, unknown>, result: unknown, toolUseResult: unknown): ToolDetail {
  const command = typeof input['command'] === 'string' ? input['command'] : ''
  let exitCode: number | null = null
  let interrupted = false
  if (isRecord(toolUseResult)) {
    const raw = toolUseResult['exitCode'] ?? toolUseResult['code']
    if (typeof raw === 'number' && Number.isFinite(raw)) exitCode = raw
    interrupted = toolUseResult['interrupted'] === true
  }
  if (exitCode === null) exitCode = exitCodeFromError(resultTextOf(result)) ?? exitCodeFromError(resultTextOf(toolUseResult))
  return { kind: 'bash', command, exitCode, interrupted }
}

function todosDetail(input: Record<string, unknown>): ToolDetail {
  const todos = input['todos']
  const items: { content: string; status: 'pending' | 'in_progress' | 'completed' }[] = []
  let droppedCount = 0
  if (Array.isArray(todos)) {
    for (const todo of todos) {
      if (!isRecord(todo)) {
        droppedCount += 1
        continue
      }
      const content = typeof todo['content'] === 'string' ? todo['content'] : ''
      const status = todo['status']
      if (typeof status === 'string' && TODO_STATUSES.has(status)) {
        items.push({ content, status: status as 'pending' | 'in_progress' | 'completed' })
      } else {
        droppedCount += 1
      }
    }
  }
  return { kind: 'todos', items, droppedCount }
}

function taskDetail(input: Record<string, unknown>): ToolDetail {
  const description = typeof input['description'] === 'string' ? input['description'] : ''
  const subagentType = typeof input['subagent_type'] === 'string' ? input['subagent_type'] : null
  return { kind: 'task', description, subagentType }
}

function lookupCount(name: string, toolUseResult: unknown, hasResult: boolean): number | null {
  if (!hasResult) return null
  const text = resultTextOf(toolUseResult)
  if (text.startsWith('No ')) return 0
  if (name === 'Read') {
    const lines = text.split('\n')
    return lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
  }
  return text.split('\n').filter((line) => line !== '').length
}

const LOOKUP_TOOLS = new Set(['Read', 'Grep', 'Glob'])

/** Derives `ToolDetail` for a tool call, given its name, raw input, the raw tool result (if any), and the raw `toolUseResult` sidecar. Pure, never throws. `null` for a tool with no dedicated card (e.g. Edit/Write, which use `diff` instead). */
export function toolDetailFor(name: string, rawInput: unknown, result: unknown, toolUseResult: unknown, hasResult: boolean): ToolDetail | null {
  const input = isRecord(rawInput) ? rawInput : {}
  if (name === 'Bash') return bashDetail(input, result, toolUseResult)
  if (name === 'TodoWrite') return todosDetail(input)
  if (name === 'Task' || name === 'Agent') return taskDetail(input)
  if (LOOKUP_TOOLS.has(name)) return { kind: 'lookup', count: lookupCount(name, result ?? toolUseResult, hasResult) }
  return null
}
