import type { ReactNode } from 'react'
import { Button } from '@/renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'

interface IconButtonProps {
  readonly label: string
  readonly tooltip?: string
  readonly onClick: () => void
  readonly expanded?: boolean
  readonly controls?: string
  readonly slot?: string
  readonly children: ReactNode
}

export function IconButton({ label, tooltip, onClick, expanded, controls, slot, children }: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon" aria-label={label} aria-expanded={expanded} aria-controls={controls} {...(slot !== undefined ? { 'data-slot': slot } : {})} onClick={onClick} className="text-foreground-secondary">
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip ?? label}</TooltipContent>
    </Tooltip>
  )
}
