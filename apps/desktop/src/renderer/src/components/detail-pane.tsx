// A reusable 290px side panel (#319) — the Board's own item detail and the
// Repositories screen's worktree detail (`repositories/worktrees-tab.tsx`)
// both compose their own content inside this shell, which owns only the
// width, padding, the 150ms-fade-plus-4px-slide entrance (reduced motion
// turns it off globally, `app.css`) and Esc-to-close. A callback `ref`
// focuses the pane on mount so `onKeyDown` alone catches Escape — no global
// listener, no `useEffect`.
import type { KeyboardEvent, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface DetailPaneProps {
  readonly onClose: () => void
  readonly children: ReactNode
  readonly className?: string
}

export function DetailPane({ onClose, children, className }: DetailPaneProps) {
  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
    }
  }

  return (
    <div
      ref={(el) => el?.focus()}
      role="complementary"
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
