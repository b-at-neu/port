// The on-demand check and the update button's one seam.
import { useSyncExternalStore } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import type { AvailableRelease, UpdateState } from '@/types/update'
import { invoke } from '@/renderer/data/invoke'
import { ipcQueryOptions } from '@/renderer/data/query'
import { runInBackground } from '@/renderer/lib/background-action'
import { createStore } from '@/renderer/shell/stores'
import { UPDATE_CHECKING } from '@/renderer/update/copy'
import { checkToastOf } from '@/renderer/update/model'

const TOAST_ID = 'update-check'

const pending = createStore(false)

export function useUpdateCheckPending(): boolean {
  return useSyncExternalStore(pending.subscribe, pending.get)
}

export function startUpdate(release: AvailableRelease): void {
  window.open(release.notesUrl, '_blank', 'noreferrer')
}

type RunCheck = (channel: 'update:check') => Promise<UpdateState>

/** Writes the result into the `update:state` cache and never invalidates it: a refetch landing after the result would overwrite it with a stale read. A failed check never replaces a known `available`. */
export async function checkForUpdates(client: QueryClient, run: RunCheck = invoke): Promise<void> {
  if (pending.get()) return
  pending.set(true)
  try {
    const result = await runInBackground({
      id: TOAST_ID,
      pending: UPDATE_CHECKING,
      run: () => run('update:check'),
      toToast: (state) => checkToastOf(state, { update: startUpdate, retry: () => void checkForUpdates(client, run) }),
    })
    if (result === 'unreachable') return
    const { queryKey } = ipcQueryOptions('update:state')
    const known = client.getQueryData(queryKey)
    if (result.kind === 'error' && known?.kind === 'available') return
    client.setQueryData(queryKey, result)
  } finally {
    pending.set(false)
  }
}
