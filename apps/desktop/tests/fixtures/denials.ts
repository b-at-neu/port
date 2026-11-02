import { createStageDenialStore } from '@/main/stage/denials'
import type { StageDenialStore } from '@/types/stage'

/** A real denial store over an in-memory file, so a dispatcher test needs no disk. */
export function memoryDenialStore(): StageDenialStore {
  return createStageDenialStore({
    path: '/tmp/stage-denials.json',
    readJson: () => Promise.resolve({ ok: false, kind: 'not-found', message: 'missing' }),
    writeJsonAtomic: () => Promise.resolve({ ok: true, value: undefined }),
  })
}
