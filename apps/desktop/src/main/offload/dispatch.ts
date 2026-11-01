import { OFFLOAD_OPS } from '@/types/offload'
import type { OffloadOp, OffloadParams, OffloadRequest, OffloadResponse, StateEngine } from '@/types/offload'

function isOffloadOp(op: string): op is OffloadOp {
  return (OFFLOAD_OPS as readonly string[]).includes(op)
}

function run(engine: StateEngine, op: OffloadOp, params: unknown): Promise<unknown> {
  switch (op) {
    case 'refreshSessions':
      return engine.refreshSessions(params as OffloadParams['refreshSessions'])
    case 'refreshWorktrees':
      return engine.refreshWorktrees(params as OffloadParams['refreshWorktrees'])
    case 'refreshDenials':
      return engine.refreshDenials(params as OffloadParams['refreshDenials'])
    case 'refreshGithub':
      return engine.refreshGithub(params as OffloadParams['refreshGithub'])
    case 'project':
      return engine.project(params as OffloadParams['project'])
    case 'scanSessions':
      return engine.scanSessions(params as OffloadParams['scanSessions'])
    case 'listSessions':
      return engine.listSessions()
    case 'search':
      return engine.search(params as OffloadParams['search'])
    case 'tailOpen':
      return engine.tailOpen(params as OffloadParams['tailOpen'])
    case 'tailPoll':
      return engine.tailPoll(params as OffloadParams['tailPoll'])
    case 'tailClose':
      return engine.tailClose(params as OffloadParams['tailClose'])
  }
}

/** An unknown op or an engine throw becomes an error reply, never an exception — the reply is the only thing the worker's caller can observe. */
export async function handleRequest(engine: StateEngine, request: OffloadRequest): Promise<OffloadResponse> {
  if (!isOffloadOp(request.op)) return { id: request.id, ok: false, message: `unknown offload op '${request.op}'` }
  try {
    return { id: request.id, ok: true, value: await run(engine, request.op, request.params) }
  } catch (error) {
    return { id: request.id, ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
