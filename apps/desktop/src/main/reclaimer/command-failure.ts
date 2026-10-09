// Maps a platform-layer failure straight through, never re-classifying.
// Shared by report.ts and reclaim.ts, so their failure copy never drifts.
import type { CommandResult } from '../platform/run'

export function describeCommandFailure(result: Exclude<CommandResult, { ok: true }>): { kind: Exclude<CommandResult, { ok: true }>['kind']; message: string } {
  switch (result.kind) {
    case 'not-found':
      return { kind: 'not-found', message: `node not found on PATH (searched: ${result.searched.join(', ')})` }
    case 'cwd-missing':
      return { kind: 'cwd-missing', message: `working directory does not exist: ${result.cwd}` }
    case 'nonzero':
      return { kind: 'nonzero', message: result.stderr.trim() || `node exited with code ${result.code}` }
    case 'signalled':
      return { kind: 'signalled', message: `node was killed by signal ${result.signal}` }
    case 'timeout':
      return { kind: 'timeout', message: `node timed out after ${result.timeoutMs}ms` }
    case 'output-too-large':
      return { kind: 'output-too-large', message: `node output exceeded ${result.maxBytes} bytes` }
    case 'spawn-failed':
      return { kind: 'spawn-failed', message: result.message }
  }
}
