// The Pipeline strip — a status chip, one button per `port:` command, an
// inline argument row, an Agents disclosure, and the invoke-refused banner.
import { useState } from 'react'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { invoke } from '../data/invoke'
import type { AgentSummary, CommandSummary, HostedSessionSnapshot, SessionKey } from '../../../shared/hosting/types'
import { argumentRequired, bannerCopy, chipCopy, INVOKE_REJECTED, invokeFailureCopy } from './commands-copy'
import { AGENTS_DISCLOSURE_NOTE } from './composer-copy'

interface OpenRow {
  readonly commandName: string
  readonly draft: string
}

export function CommandStrip({ snapshot }: { readonly snapshot: HostedSessionSnapshot }) {
  const [openRow, setOpenRow] = useState<OpenRow | null>(null)
  const [invokeFailure, setInvokeFailure] = useState<string | null>(null)

  if (snapshot.phase === 'ended') return null

  const { capabilities } = snapshot
  const chipTitle = capabilities.kind === 'ready' && (capabilities.plugin.kind === 'loaded' || capabilities.plugin.kind === 'shadowed') ? capabilities.plugin.path : undefined
  const banner = bannerCopy(capabilities)

  async function run(sessionKey: SessionKey, name: string, args: string): Promise<void> {
    try {
      const result = await invoke('session:invoke', { sessionKey, name, args })
      if (!result.ok) {
        setInvokeFailure(invokeFailureCopy(name, result))
      } else {
        setInvokeFailure(null)
        setOpenRow((row) => (row?.commandName === name ? null : row))
      }
    } catch (error) {
      console.error('Failed to reach the main process invoking a command', error)
      setInvokeFailure(INVOKE_REJECTED)
    }
  }

  function handleCommandClick(command: CommandSummary): void {
    if (command.argumentHint === '') {
      void run(snapshot.sessionKey, command.name, '')
      return
    }
    setOpenRow({ commandName: command.name, draft: '' })
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span title={chipTitle} className="text-meta text-muted-foreground">
        {chipCopy(capabilities)}
      </span>
      {banner !== null ? (
        <div aria-live="polite" className="flex flex-col gap-1 rounded-md bg-muted px-2 py-1.5 text-meta text-foreground-secondary">
          <p>{banner.text}</p>
          {banner.detail !== null ? <pre className="overflow-x-auto font-mono whitespace-pre-wrap">{banner.detail}</pre> : null}
        </div>
      ) : null}
      {invokeFailure !== null ? <p className="text-meta text-danger-pill-foreground">{invokeFailure}</p> : null}

      {capabilities.kind === 'ready' && capabilities.plugin.kind !== 'missing' ? (
        <>
          {capabilities.commands.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {capabilities.commands.map((command) => (
                <Button
                  key={command.name}
                  variant="outline"
                  size="small"
                  disabled={snapshot.phase === 'closing'}
                  title={snapshot.phase === 'streaming' || snapshot.phase === 'interrupting' ? `Runs after the current turn${command.description === '' ? '' : `\n${command.description}`}` : command.description}
                  onClick={() => handleCommandClick(command)}
                >
                  /port:{command.name}
                </Button>
              ))}
            </div>
          ) : null}

          {openRow !== null
            ? (() => {
                const command = capabilities.commands.find((candidate) => candidate.name === openRow.commandName)
                if (command === undefined) return null
                const required = argumentRequired(command.argumentHint) && openRow.draft.trim() === ''
                return (
                  <div className="flex flex-col gap-1 rounded-md border border-border p-2">
                    <span className="font-mono text-meta text-muted-foreground">/port:{command.name}</span>
                    <Textarea
                      autoFocus
                      rows={2}
                      value={openRow.draft}
                      placeholder={command.argumentHint}
                      onChange={(event) => setOpenRow({ ...openRow, draft: event.target.value })}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          setOpenRow(null)
                        } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                          event.preventDefault()
                          void run(snapshot.sessionKey, command.name, openRow.draft)
                        }
                      }}
                    />
                    {command.description !== '' ? <p className="text-meta text-muted-foreground">{command.description}</p> : null}
                    <div className="flex gap-2">
                      <Button size="small" disabled={required} onClick={() => void run(snapshot.sessionKey, command.name, openRow.draft)}>
                        Run
                      </Button>
                      <Button size="small" variant="outline" onClick={() => setOpenRow(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )
              })()
            : null}

          {capabilities.agents.length > 0 ? <AgentsDisclosure agents={capabilities.agents} /> : null}
        </>
      ) : null}
    </div>
  )
}

function AgentsDisclosure({ agents }: { readonly agents: readonly AgentSummary[] }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="flex h-7 items-center gap-1.5 rounded-md px-1 text-left text-small text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
        Agents · {agents.length}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-1 px-1 py-1">
        {agents.map((agent) => (
          <div key={agent.name} className="flex flex-col text-meta">
            <span className="text-foreground-secondary">{agent.model === null ? `port:${agent.name}` : `port:${agent.name} · ${agent.model}`}</span>
            {agent.description !== '' ? <span className="text-muted-foreground">{agent.description}</span> : null}
          </div>
        ))}
        <p className="text-meta text-muted-foreground">{AGENTS_DISCLOSURE_NOTE}</p>
      </CollapsibleContent>
    </Collapsible>
  )
}
