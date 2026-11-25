import { parentPort, workerData } from 'node:worker_threads'
import type { OffloadRequest } from '@/types/offload'
import type { PlatformPaths } from '@/types/platform'
import { createPlatform, headlessHost } from '@/main/platform'
import { createInProcessEngine } from '@/main/worker/engine'
import { handleRequest } from '@/main/worker/dispatch'
import { stagePromptsDir } from '@/main/sessions/hosting/stage-prompt-store'

function isWorkerData(value: unknown): value is { readonly paths: PlatformPaths } {
  return typeof value === 'object' && value !== null && typeof (value as { paths?: unknown }).paths === 'object'
}

if (!isWorkerData(workerData)) throw new Error('the state worker was started without its paths')

const engine = createInProcessEngine({ ...createPlatform(headlessHost(workerData.paths)), stagePromptsDir: stagePromptsDir(workerData.paths.userData) })

parentPort?.on('message', (request: OffloadRequest) => {
  void handleRequest(engine, request).then((response) => parentPort?.postMessage(response))
})
