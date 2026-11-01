import { parentPort, workerData } from 'node:worker_threads'
import type { OffloadRequest } from '@/types/offload'
import { setE2ERoute } from '@/main/platform/run'
import { createInProcessEngine } from '@/main/offload/engine'
import { handleRequest } from '@/main/offload/dispatch'

const fake = (workerData as { readonly e2eFake?: string | null } | null)?.e2eFake
if (typeof fake === 'string') setE2ERoute({ fake })

const engine = createInProcessEngine()

parentPort?.on('message', (request: OffloadRequest) => {
  void handleRequest(engine, request).then((response) => parentPort?.postMessage(response))
})
