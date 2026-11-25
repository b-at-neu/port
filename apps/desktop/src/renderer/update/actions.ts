// The on-demand check and the update button's one seam. They run through `perform` rather than a hook
// because the app menu, the keyboard and toast actions call them from outside React.
import type { QueryClient } from '@tanstack/react-query'
import type { UpdateDownloadAction } from '@/types/update'
import { invoke } from '@/renderer/data/invoke'
import { ipcQueryOptions } from '@/renderer/data/query'
import { perform } from '@/renderer/actions/perform'
import { showActionToast } from '@/renderer/lib/background-action'
import { createStore, useStore } from '@/renderer/lib/store'
import { UPDATE_CHECKING } from '@/renderer/update/copy'
import { checkToastOf, downloadToastOf, nextUpdateState } from '@/renderer/update/model'

const pending = createStore(false)

export function useUpdateCheckPending(): boolean {
  return useStore(pending)
}

const DOWNLOAD_TOAST_ID = 'update-download'

function openReleasePage(notesUrl: string): void {
  window.open(notesUrl, '_blank', 'noreferrer')
}

/** The one seam every Update button calls. The pending state is the progress bar itself, so no loading toast. */
export async function startUpdate(client: QueryClient): Promise<void> {
  const { queryKey } = ipcQueryOptions('update.downloadState')
  const download = perform({ name: 'update.download', input: undefined }, { invoke, client })
  void client.refetchQueries({ queryKey })
  const result = await download
  if (result === 'unreachable') return
  client.setQueryData(queryKey, result)
  const next = downloadToastOf(result, { retry: () => void startUpdate(client), openPage: openReleasePage })
  if (next !== null) showActionToast(DOWNLOAD_TOAST_ID, next)
}

export async function openDownloaded(client: QueryClient, reveal: boolean): Promise<void> {
  const result = await perform({ name: 'update.open', input: { reveal } }, { invoke, client })
  if (result !== 'unreachable') client.setQueryData(ipcQueryOptions('update.downloadState').queryKey, result)
}

/** Runs what a `DownloadControls` button or the rail icon asks for. */
export function runDownloadAction(client: QueryClient, action: UpdateDownloadAction, notesUrl: string): void {
  if (action === 'download') void startUpdate(client)
  else if (action === 'open-page') openReleasePage(notesUrl)
  else void openDownloaded(client, action === 'reveal')
}

/** Writes the result into the `update:state` cache and never invalidates it: a refetch landing after the result would overwrite it with a stale read. */
export async function checkForUpdates(client: QueryClient): Promise<void> {
  if (pending.get()) return
  pending.set(true)
  try {
    const result = await perform(
      {
        name: 'update.check',
        input: undefined,
        toast: {
          id: () => 'update-check',
          pending: UPDATE_CHECKING,
          result: (state) => checkToastOf(state, { update: () => void startUpdate(client), retry: () => void checkForUpdates(client) }),
        },
      },
      { invoke, client },
    )
    if (result === 'unreachable') return
    const { queryKey } = ipcQueryOptions('update.state')
    client.setQueryData(queryKey, nextUpdateState(client.getQueryData(queryKey), result))
  } finally {
    pending.set(false)
  }
}
