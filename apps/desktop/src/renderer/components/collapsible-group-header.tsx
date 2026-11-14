// DESIGN §4 — a 32px sidebar group header with a chevron toggle, a label and an optional trailing control.
import type { ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

interface CollapsibleGroupHeaderProps {
  readonly label: string
  readonly collapsed: boolean
  readonly onToggle: () => void
  readonly toggleLabel: string
  readonly toggleSlot: string
  readonly children?: ReactNode
}

const FOCUS_RING = 'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'

export function CollapsibleGroupHeader({ label, collapsed, onToggle, toggleLabel, toggleSlot, children }: CollapsibleGroupHeaderProps) {
  const Chevron = collapsed ? ChevronRight : ChevronDown
  return (
    <div className="flex h-8 items-center justify-between bg-sidebar pr-4 text-small font-medium text-foreground-secondary">
      <button type="button" data-slot={toggleSlot} aria-expanded={!collapsed} aria-label={toggleLabel} onClick={onToggle} className={`sticky left-0 flex h-full items-center gap-1 bg-sidebar pl-4 pr-2 hover:bg-accent ${FOCUS_RING}`}>
        <Chevron aria-hidden="true" className="size-3.5" />
        <span>{label}</span>
      </button>
      {children}
    </div>
  )
}
