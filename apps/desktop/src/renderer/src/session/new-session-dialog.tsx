// The app-wide New session dialog (DESIGN §3/§4) — folder picker, optional worktree, start.
import { useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ErrorBanner } from '../components/error-banner'
import { useIpcQuery } from '../data/query'
import { invoke } from '../data/invoke'
import type { RepositoryEntry } from '../../../shared/repos'
import type { FolderEntry, FolderId } from '../../../shared/workspace/types'
import { closeNewSessionDialog, useNewSessionDialog } from '../shell/stores'
import { effectiveWorktree, initialFolderId, orderFolders, worktreeControl, worktreeHint } from './new-session-model'
import { startInFolder } from './actions'
import type { RenderableStartFailure } from './copy'
import { NEW_SESSION_CANCEL, NEW_SESSION_CHOOSE_FOLDER, NEW_SESSION_DIALOG_TITLE, NEW_SESSION_EMPTY_LINE, NEW_SESSION_FOLDERS_FAILED, NEW_SESSION_START, NEW_SESSION_STARTING, NEW_SESSION_WORKTREE_LABEL } from './copy'

export function NewSessionDialog() {
  const { open, preselect } = useNewSessionDialog()

  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeNewSessionDialog()}>
      {open ? <NewSessionDialogContent preselect={preselect} /> : null}
    </Dialog>
  )
}

function slugFor(repos: readonly RepositoryEntry[] | undefined, folder: FolderEntry): string {
  const entry = repos?.find((candidate) => candidate.id === folder.repoId)
  if (entry === undefined) return folder.name
  return 'config' in entry ? entry.config.repo : entry.displayName
}

function NewSessionDialogContent({ preselect }: { readonly preselect: Parameters<typeof initialFolderId>[1] }) {
  const folders = useIpcQuery('folders:list')
  const sessions = useIpcQuery('session:list')
  const repos = useIpcQuery('repos:list')
  const list = folders.data?.folders ?? []
  const { repos: repoFolders, recents } = orderFolders(list)

  const [selectedId, setSelectedId] = useState<FolderId | null>(() => initialFolderId(list, preselect))
  const [userChecked, setUserChecked] = useState(false)
  const [busyOverride, setBusyOverride] = useState(false)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<{ readonly title: string; readonly body: string; readonly detail: string | null } | null>(null)

  const selected = list.find((folder) => folder.id === selectedId) ?? null
  const control = selected !== null ? worktreeControl(selected, sessions.data ?? []) : { kind: 'free' as const }
  const checked = selected !== null ? effectiveWorktree(control, userChecked, busyOverride) : false
  const hint = selected !== null ? worktreeHint(selected) : null

  function selectFolder(id: FolderId): void {
    setSelectedId(id)
    setUserChecked(false)
    setBusyOverride(false)
    setFailure(null)
  }

  async function chooseFolder(): Promise<void> {
    const result = await invoke('folders:choose')
    if (result.outcome === 'chosen') {
      void folders.refetch()
      selectFolder(result.folder.id)
    }
  }

  async function handleStart(): Promise<void> {
    if (selected === null) return
    setPending(true)
    setFailure(null)
    const outcome = await startInFolder(selected.id, checked)
    setPending(false)
    if (outcome.kind === 'started') {
      closeNewSessionDialog()
      return
    }
    setFailure(outcome.copy)
    handleFailureSideEffects(outcome.result)
  }

  function handleFailureSideEffects(result: RenderableStartFailure | null): void {
    if (result === null) return
    if (result.kind === 'folder-missing') void folders.refetch()
    if (result.kind === 'folder-busy') setBusyOverride(true)
  }

  return (
    <DialogContent data-slot="new-session-dialog">
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (selected !== null && !pending) void handleStart()
        }}
      >
      <DialogHeader>
        <DialogTitle>{NEW_SESSION_DIALOG_TITLE}</DialogTitle>
      </DialogHeader>
      {folders.status === 'pending' ? (
        <Skeleton className="h-8 w-full" />
      ) : folders.status === 'error' ? (
        <ErrorBanner message={NEW_SESSION_FOLDERS_FAILED} />
      ) : list.length === 0 ? (
        <p className="text-small text-muted-foreground">{NEW_SESSION_EMPTY_LINE}</p>
      ) : (
        <Select value={selectedId ?? undefined} onValueChange={(value) => selectFolder(value as FolderId)}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Choose a folder" />
          </SelectTrigger>
          <SelectContent>
            {repoFolders.map((folder) => (
              <FolderOption key={folder.id} folder={folder} label={slugFor(repos.data?.ok === true ? repos.data.repositories : undefined, folder)} />
            ))}
            {recents.map((folder) => (
              <FolderOption key={folder.id} folder={folder} label={folder.name} />
            ))}
          </SelectContent>
        </Select>
      )}
      <Button type="button" variant="outline" size="small" className="self-start" onClick={() => void chooseFolder()}>
        {NEW_SESSION_CHOOSE_FOLDER}
      </Button>
      {selected !== null ? (
        <div className="flex flex-col gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <label className="flex items-center gap-2 text-small">
                <Checkbox checked={checked} disabled={control.kind !== 'free'} onCheckedChange={(value) => setUserChecked(value === true)} />
                {NEW_SESSION_WORKTREE_LABEL}
              </label>
            </TooltipTrigger>
            {control.kind !== 'free' ? <TooltipContent>{control.reason}</TooltipContent> : null}
          </Tooltip>
          {hint !== null && control.kind === 'free' ? <p className="pl-6 text-meta text-muted-foreground">{hint}</p> : null}
        </div>
      ) : null}
      {failure !== null ? (
        <>
          <ErrorBanner message={`${failure.title}. ${failure.body}`} />
          {failure.detail !== null ? <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-meta whitespace-pre-wrap">{failure.detail}</pre> : null}
        </>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={closeNewSessionDialog}>
          {NEW_SESSION_CANCEL}
        </Button>
        <Button type="submit" disabled={selected === null || pending}>
          {pending ? NEW_SESSION_STARTING : NEW_SESSION_START}
        </Button>
      </DialogFooter>
      </form>
    </DialogContent>
  )
}

function FolderOption({ folder, label }: { readonly folder: FolderEntry; readonly label: string }) {
  return (
    <SelectItem value={folder.id}>
      <div className="flex flex-col">
        <span>{label}</span>
        <span className="font-mono text-meta text-muted-foreground">{folder.path}</span>
      </div>
    </SelectItem>
  )
}
