// "Allow from now on" — the denial row's own confirmation, an editable rule `Input` that main
// re-validates. The same `useSyncExternalStore` store shape `decision/controller.ts` establishes.
import { useState, useSyncExternalStore } from 'react'
import { Button } from '@/renderer/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/renderer/components/ui/dialog'
import { Input } from '@/renderer/components/ui/input'
import type { RepoId } from '@/utils/repos'
import type { StageDenial, StageAllowResult } from '@/types/stage'
import type { ActionToast } from '@/types/toast'
import { invoke } from '@/renderer/data/invoke'
import { runInBackground } from '@/renderer/lib/background-action'
import { useQueryClient } from '@tanstack/react-query'
import { ipcQueryOptions } from '@/renderer/data/query'

type AllowDialogState = { readonly open: false } | { readonly open: true; readonly repoId: RepoId; readonly denial: StageDenial; readonly rule: string }

let state: AllowDialogState = { open: false }
const listeners = new Set<() => void>()
function notify(): void {
  for (const listener of listeners) listener()
}
function setState(next: AllowDialogState): void {
  state = next
  notify()
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
function getState(): AllowDialogState {
  return state
}

export function openAllowDialog(repoId: RepoId, denial: StageDenial): void {
  setState({ open: true, repoId, denial, rule: denial.rule })
}

function closeAllowDialog(): void {
  setState({ open: false })
}

function resultToast(rule: string, result: StageAllowResult): ActionToast {
  const openPr = (url: string) => ({ label: 'Open PR', onClick: () => void window.open(url, '_blank') })
  const plain = { description: null, action: null, cancel: null } as const
  switch (result.kind) {
    case 'proposed':
      return { ...plain, tone: 'success', title: `Opened PR#${String(result.number)} to allow ${rule}. Merge it to apply.`, action: openPr(result.url) }
    case 'already-proposed':
      return { ...plain, tone: 'info', title: `PR#${String(result.number)} already proposes ${rule}. Merge it to apply.`, action: openPr(result.url) }
    case 'already-allowed':
      return { ...plain, tone: 'info', title: `${rule} is already allowed on ${result.integration}.` }
    case 'invalid-rule':
      return { ...plain, tone: 'error', title: `Couldn't allow ${rule}: ${result.reason}.` }
    case 'failed':
      return { ...plain, tone: 'error', title: `Couldn't open the allow PR (${result.step}): ${result.message}` }
    case 'unknown-denial':
      return { ...plain, tone: 'info', title: "That denial isn't tracked any more." }
  }
}

export function AllowDialog() {
  const current = useSyncExternalStore(subscribe, getState)
  const queryClient = useQueryClient()
  const [rule, setRule] = useState('')

  if (!current.open) return <Dialog open={false} onOpenChange={() => undefined} />
  const displayRule = rule === '' ? current.rule : rule

  async function submit(): Promise<void> {
    if (!current.open) return
    const { repoId, denial } = current
    closeAllowDialog()
    setRule('')
    await runInBackground({
      id: `allow:${repoId}:${denial.id}`,
      pending: 'Opening the allow PR…',
      run: () => invoke('stage:allow', { repoId, denialId: denial.id, rule: displayRule }),
      toToast: (result) => resultToast(displayRule, result),
    })
    void queryClient.invalidateQueries({ queryKey: ipcQueryOptions('board:snapshot').queryKey })
  }

  async function dismiss(): Promise<void> {
    if (!current.open) return
    const { repoId, denial } = current
    closeAllowDialog()
    setRule('')
    await runInBackground({
      id: `allow-dismiss:${repoId}:${denial.id}`,
      pending: 'Dismissing the denial…',
      run: () => invoke('stage:dismiss-denial', { repoId, denialId: denial.id }),
      toToast: () => ({ tone: 'success', title: 'Dismissed the denial.', description: null, action: null, cancel: null }),
    })
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          closeAllowDialog()
          setRule('')
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Allow this from now on?</DialogTitle>
        </DialogHeader>
        <p className="text-small text-muted-foreground">
          Opens a PR into the integration branch that adds this rule to .claude/settings.json and extraAllow in .claude/port.config.json. Stage sessions get it once the PR merges.
        </p>
        <Input value={displayRule} onChange={(event) => setRule(event.target.value)} />
        <DialogFooter>
          <Button variant="outline" onClick={closeAllowDialog}>
            Cancel
          </Button>
          <Button variant="ghost" onClick={() => void dismiss()}>
            Dismiss
          </Button>
          <Button onClick={() => void submit()}>Open allow PR</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
