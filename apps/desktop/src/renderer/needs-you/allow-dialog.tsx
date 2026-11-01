// "Allow from now on" — the denial row's own confirmation, an editable rule `Input` that main
// re-validates. The same `useSyncExternalStore` store shape `decision/controller.ts` establishes.
import { useState, useSyncExternalStore } from 'react'
import { Button } from '@/renderer/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/renderer/components/ui/dialog'
import { Input } from '@/renderer/components/ui/input'
import { toast } from 'sonner'
import type { RepoId } from '@/utils/repos'
import type { StageDenial, StageAllowResult } from '@/types/stage'
import { invoke } from '@/renderer/data/invoke'
import { useQueryClient } from '@tanstack/react-query'
import { ipcQueryOptions } from '@/renderer/data/query'

type AllowDialogState = { readonly open: false } | { readonly open: true; readonly repoId: RepoId; readonly denial: StageDenial; readonly rule: string; readonly submitting: boolean }

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
  setState({ open: true, repoId, denial, rule: denial.rule, submitting: false })
}

function closeAllowDialog(): void {
  setState({ open: false })
}

function showResult(rule: string, result: StageAllowResult): void {
  const openPr = (url: string) => ({ label: 'Open PR', onClick: () => void window.open(url, '_blank') })
  switch (result.kind) {
    case 'proposed':
      toast(`Opened PR#${String(result.number)} to allow ${rule}. Merge it to apply.`, { action: openPr(result.url) })
      return
    case 'already-proposed':
      toast(`PR#${String(result.number)} already proposes ${rule}. Merge it to apply.`, { action: openPr(result.url) })
      return
    case 'already-allowed':
      toast(`${rule} is already allowed on ${result.integration}.`)
      return
    case 'invalid-rule':
      toast(`Couldn't allow ${rule}: ${result.reason}.`)
      return
    case 'failed':
      toast(`Couldn't open the allow PR (${result.step}): ${result.message}`)
      return
    case 'unknown-denial':
      toast("That denial isn't tracked any more.")
      return
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
    setState({ ...current, submitting: true })
    try {
      const result = await invoke('stage:allow', { repoId: current.repoId, denialId: current.denial.id, rule: displayRule })
      showResult(displayRule, result)
      void queryClient.invalidateQueries({ queryKey: ipcQueryOptions('board:snapshot').queryKey })
    } catch (error) {
      console.error('Failed to reach the main process while allowing a rule', error)
      toast(`Couldn't reach the main process to allow ${displayRule}.`)
    } finally {
      closeAllowDialog()
      setRule('')
    }
  }

  async function dismiss(): Promise<void> {
    if (!current.open) return
    try {
      await invoke('stage:dismiss-denial', { repoId: current.repoId, denialId: current.denial.id })
    } catch (error) {
      console.error('Failed to reach the main process while dismissing a denial', error)
    } finally {
      closeAllowDialog()
      setRule('')
    }
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
          <Button onClick={() => void submit()} disabled={current.submitting}>
            {current.submitting ? 'Opening…' : 'Open allow PR'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
