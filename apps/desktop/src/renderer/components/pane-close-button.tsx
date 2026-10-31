// The X at the top right of a detail pane — icon-only, so it carries both a tooltip and an accessible name.
import { X } from 'lucide-react'
import { Button } from '@/renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'

export function PaneCloseButton({ label, onClick }: { readonly label: string; readonly onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="small" aria-label={label} onClick={onClick}>
          <X aria-hidden="true" className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
