import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { OffloadOp, OffloadParams, OffloadRequest, OffloadResponse, OffloadValue, StateEngine } from '@/types/offload'
import type { RefreshOutcome } from '@/types/state'

interface OffloadWorker {
  postMessage(request: OffloadRequest): void
  on(event: 'message', listener: (response: OffloadResponse) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
}

interface WorkerEngineOptions {
  readonly e2eFake?: string | null
  readonly spawn?: () => OffloadWorker
  readonly now?: () => Date
  readonly onRespawn?: () => void
}

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function spawnStateWorker(e2eFake: string | null): OffloadWorker {
  const worker = new Worker(join(__dirname, 'state-worker.js'), { workerData: { e2eFake } })
  worker.unref()
  return worker
}

/** Spawned lazily, so the worker's copy of `process.env` carries the login-shell PATH. A crash fails every pending request and the next call respawns it. */
export function createWorkerEngine(options: WorkerEngineOptions = {}): StateEngine {
  const spawn = options.spawn ?? (() => spawnStateWorker(options.e2eFake ?? null))
  const now = options.now ?? (() => new Date())
  const pending = new Map<number, Pending>()
  let worker: OffloadWorker | null = null
  let nextId = 0
  let crashed = false

  function stopped(current: OffloadWorker, reason: string): void {
    if (worker !== current) return
    worker = null
    crashed = true
    const error = new Error(`state worker stopped: ${reason}`)
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }

  function ensureWorker(): OffloadWorker {
    if (worker !== null) return worker
    const created = spawn()
    created.on('message', (response) => {
      const request = pending.get(response.id)
      if (request === undefined) return
      pending.delete(response.id)
      if (response.ok) request.resolve(response.value)
      else request.reject(new Error(response.message))
    })
    created.on('error', (error) => stopped(created, error.message))
    created.on('exit', (code) => stopped(created, `exited with code ${String(code)}`))
    worker = created
    if (crashed) {
      crashed = false
      // The new worker's cache is empty, so the caller must re-read every source rather than wait for each to fall due.
      queueMicrotask(() => options.onRespawn?.())
    }
    return created
  }

  function call<K extends OffloadOp>(op: K, params: OffloadParams[K]): Promise<OffloadValue[K]> {
    return new Promise<unknown>((resolve, reject) => {
      nextId += 1
      const id = nextId
      pending.set(id, { resolve, reject })
      try {
        ensureWorker().postMessage({ id, op, params })
      } catch (error) {
        pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    }) as Promise<OffloadValue[K]>
  }

  const failedOutcome = (error: unknown): RefreshOutcome => ({ ok: false, at: now().toISOString(), error: reasonOf(error) })

  return {
    refreshSessions: (params) => call('refreshSessions', params).catch(failedOutcome),
    refreshWorktrees: (params) => call('refreshWorktrees', params).catch(failedOutcome),
    refreshDenials: (params) => call('refreshDenials', params).catch(failedOutcome),
    refreshGithub: (params) => call('refreshGithub', params).catch(failedOutcome),
    project: (params) => call('project', params),
    scanSessions: (params) => call('scanSessions', params).catch((error: unknown) => ({ ok: false, kind: 'sdk-failed', message: reasonOf(error), scannedAt: now().toISOString() })),
    listSessions: () => call('listSessions', undefined).catch((error: unknown) => ({ ok: false, kind: 'sdk-failed', message: reasonOf(error) })),
    search: (params) => call('search', params),
    tailOpen: (params) => call('tailOpen', params),
    tailPoll: (params) => call('tailPoll', params),
    tailClose: (params) => call('tailClose', params).catch(() => undefined),
  }
}
