import { parentPort } from 'node:worker_threads'
import type { OffloadRequest } from '@/types/offload'
import { createInProcessEngine } from '@/main/offload/engine'
import { handleRequest } from '@/main/offload/dispatch'

const engine = createInProcessEngine()

parentPort?.on('message', (request: OffloadRequest) => {
  void handleRequest(engine, request).then((response) => parentPort?.postMessage(response))
})
