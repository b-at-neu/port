// The footer's status dot and its connection overview. Opens on hover, focus and click; leaving closes
// it after a short delay held in a ref, and Esc closes it. Never claims ready while a query is pending.
import { useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { cn } from '@/renderer/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/renderer/components/ui/popover'
import { ROUTE_IDS } from '@/renderer/router/routes'
import { connectionText } from '@/renderer/settings/connections-model'
import { useConnectionOverview } from '@/renderer/settings/use-connection-overview'
import { footerStatus } from '@/renderer/shell/status-model'

const CLOSE_DELAY_MS = 150

const DOT_CLASS: Readonly<Record<'success' | 'attention' | 'danger' | 'idle', string>> = {
  success: 'bg-success-dot',
  attention: 'bg-attention-dot',
  danger: 'bg-danger-dot',
  idle: 'bg-idle-dot',
}

export function StatusPopover() {
  const { lines, preflight, gh } = useConnectionOverview()
  const status = footerStatus(preflight, gh)
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function cancelClose(): void {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }

  function show(): void {
    cancelClose()
    setOpen(true)
  }

  function scheduleClose(): void {
    cancelClose()
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="status-dot"
          aria-label={`Connections: ${status.tooltip}. Show details.`}
          onPointerEnter={show}
          onPointerLeave={scheduleClose}
          onFocus={(event) => {
            if (event.currentTarget.matches(':focus-visible')) show()
          }}
          onClick={(event) => {
            event.preventDefault()
            show()
          }}
          className="flex size-6 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span aria-hidden="true" className={cn('size-2 rounded-full', DOT_CLASS[status.status])} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        data-slot="status-popover"
        side="top"
        className="w-80"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={cancelClose}
        onPointerLeave={scheduleClose}
      >
        <ul className="flex flex-col gap-1.5">
          {lines.map((line) => (
            <li key={line.key} className="flex items-start gap-2 text-small text-foreground">
              <span aria-hidden="true" className={cn('mt-1.5 size-2 shrink-0 rounded-full', DOT_CLASS[line.tone])} />
              <span className="min-w-0">{connectionText(line)}</span>
            </li>
          ))}
        </ul>
        <Link
          to={ROUTE_IDS.settings}
          search={{ section: 'connections' }}
          onClick={() => setOpen(false)}
          className="mt-3 inline-block rounded text-small text-primary-text hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          Open Connections
        </Link>
      </PopoverContent>
    </Popover>
  )
}
