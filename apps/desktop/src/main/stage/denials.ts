// stage-denials.json's only writer: pending "Allow from now on" items survive a relaunch here. A
// missing or malformed file loads as empty, the same recoverable-state shape as registry.ts.
import type { StageDenial, StageDenialStore } from '@/types/stage'
import type { FileResult } from '@/types/platform'
import type { RepoId } from '@/utils/repos'
import { withDenial, withoutDenialId, withoutDenialRule } from '@/main/dispatch/attention'

const CURRENT_VERSION = 1

interface DenialsFileShape {
  readonly version: number
  readonly entries: readonly unknown[]
}

interface CreateStageDenialStoreParams {
  readonly path: string
  readonly readJson: <T>(path: string) => Promise<FileResult<T>>
  readonly writeJsonAtomic: (path: string, value: unknown) => Promise<FileResult<void>>
}

function isStageDenial(value: unknown): value is StageDenial {
  if (typeof value !== 'object' || value === null) return false
  const d = value as Record<string, unknown>
  return (
    typeof d.id === 'string' &&
    d.id !== '' &&
    typeof d.repoId === 'string' &&
    typeof d.agent === 'string' &&
    typeof d.number === 'number' &&
    typeof d.toolName === 'string' &&
    typeof d.inputSummary === 'string' &&
    typeof d.rule === 'string' &&
    typeof d.at === 'string' &&
    (d.sessionKey === null || typeof d.sessionKey === 'string')
  )
}

/** `createStageDenialStore({ path, readJson, writeJsonAtomic })` — a write failure is logged and the in-memory state is kept, which fails toward showing the item this run. */
export function createStageDenialStore(params: CreateStageDenialStoreParams): StageDenialStore {
  let byRepo = new Map<RepoId, readonly StageDenial[]>()

  function persist(): void {
    const entries = [...byRepo.values()].flat()
    void params.writeJsonAtomic(params.path, { version: CURRENT_VERSION, entries }).then((result) => {
      if (!result.ok) console.error(`[stage] could not write ${params.path}: ${result.message}`)
    })
  }

  function set(repoId: RepoId, denials: readonly StageDenial[]): void {
    byRepo = new Map(byRepo).set(repoId, denials)
    persist()
  }

  async function load(): Promise<void> {
    const result = await params.readJson<DenialsFileShape>(params.path)
    const value = result.ok ? result.value : null
    if (typeof value !== 'object' || value === null || !Array.isArray(value.entries)) return
    let loaded = new Map<RepoId, readonly StageDenial[]>()
    for (const entry of value.entries.filter(isStageDenial)) loaded = new Map(loaded).set(entry.repoId, withDenial(loaded.get(entry.repoId) ?? [], entry))
    const recorded = [...byRepo.values()].flat()
    for (const entry of recorded) loaded = new Map(loaded).set(entry.repoId, withDenial(loaded.get(entry.repoId) ?? [], entry))
    byRepo = loaded
    if (recorded.length > 0) persist()
  }

  function list(repoId: RepoId): readonly StageDenial[] {
    return byRepo.get(repoId) ?? []
  }

  return {
    load,
    record: (denial) => set(denial.repoId, withDenial(list(denial.repoId), denial)),
    dismiss: (repoId, id) => set(repoId, withoutDenialId(list(repoId), id)),
    clearRule: (repoId, rule) => set(repoId, withoutDenialRule(list(repoId), rule)),
    list,
  }
}
