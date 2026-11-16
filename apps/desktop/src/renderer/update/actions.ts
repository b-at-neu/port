// The on-demand check and the update button's one seam.
import { useSyncExternalStore } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import type { UpdateDownloadAction, UpdateDownloadState, UpdateState } from '@/types/update'
import { invoke } from '@/renderer/data/invoke'
import { ipcQueryOptions } from '@/renderer/data/query'
import { runInBackground, showActionToast, UNREACHABLE } from '@/renderer/lib/background-action'
import { createStore } from '@/renderer/shell/stores'
import { UPDATE_CHECKING } from '@/renderer/update/copy'
import { checkToastOf, downloadToastOf } from '@/renderer/update/model'

const TOAST_ID = 'update-check'

const pending = createStore(false)

export function useUpdateCheckPending(): boolean {
  return useSyncExternalStore(pending.subscribe, pending.get)
}

const DOWNLOAD_TOAST_ID = 'update-download'

type RunDownload = (channel: 'update:download') => Promise<UpdateDownloadState>
type RunOpen = (channel: 'update:open', request: { reveal: boolean }) => Promise<UpdateDownloadState>

function openReleasePage(notesUrl: string): void {
  window.open(notesUrl, '_blank', 'noreferrer')
}

/** The one seam every Update button calls. The pending state is the progress bar itself, so no loading toast. */
export async function startUpdate(client: QueryClient, run: RunDownload = invoke): Promise<void> {
  const { queryKey } = ipcQueryOptions('update:download:state')
  const pending = run('update:download')
  void client.refetchQueries({ queryKey })
  let result: UpdateDownloadState
  try {
    result = await pending
  } catch (error) {
    console.error('Failed to reach the main process for update:download', error)
    showActionToast(DOWNLOAD_TOAST_ID, UNREACHABLE)
    return
  }
  client.setQueryData(queryKey, result)
  const next = downloadToastOf(result, { retry: () => void startUpdate(client, run), openPage: openReleasePage })
  if (next !== null) showActionToast(DOWNLOAD_TOAST_ID, next)
}

export async function openDownloaded(client: QueryClient, reveal: boolean, run: RunOpen = invoke): Promise<void> {
  try {
    client.setQueryData(ipcQueryOptions('update:download:state').queryKey, await run('update:open', { reveal }))
  } catch (error) {
    console.error('Failed to reach the main process for update:open', error)
    showActionToast(DOWNLOAD_TOAST_ID, UNREACHABLE)
  }
}

/** Runs what a `DownloadControls` button or the rail icon asks for. */
export function runDownloadAction(client: QueryClient, action: UpdateDownloadAction, notesUrl: string): void {
  if (action === 'download') void startUpdate(client)
  else if (action === 'open-page') openReleasePage(notesUrl)
  else void openDownloaded(client, action === 'reveal')
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
      toToast: (state) => checkToastOf(state, { update: () => void startUpdate(client), retry: () => void checkForUpdates(client, run) }),
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
