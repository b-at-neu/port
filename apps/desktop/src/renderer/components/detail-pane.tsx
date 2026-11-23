// A reusable 290px side panel. A callback ref focuses the pane on mount so
// onKeyDown alone catches Escape — no global listener, no useEffect.
import type { KeyboardEvent, ReactNode } from 'react'
import { cn } from '@/renderer/lib/utils'

interface DetailPaneProps {
  readonly onClose: () => void
  readonly children: ReactNode
  readonly className?: string
  readonly 'aria-label'?: string
  readonly 'data-slot'?: string
  readonly 'data-ticket'?: number
}

// Module-level so its identity is stable and React calls it only on attach.
function focusOnMount(el: HTMLDivElement | null): void {
  el?.focus()
}

export function DetailPane({ onClose, children, className, 'aria-label': ariaLabel, 'data-slot': dataSlot, 'data-ticket': dataTicket }: DetailPaneProps) {
  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
    }
  }

  return (
    <div
      ref={focusOnMount}
      role="complementary"
      aria-label={ariaLabel}
      data-slot={dataSlot}
      data-ticket={dataTicket}
      data-keeps-selection
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className={cn(
        'flex w-[290px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-border p-4 outline-none',
        'animate-in fade-in-0 slide-in-from-right-1 duration-150 ease-out',
        className,
      )}
    >
      {children}
    </div>
  )
}
