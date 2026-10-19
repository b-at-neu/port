// DESIGN §4 LabelChip — a GitHub label in its own colour, black or white text by contrast.
import { cn } from '@/renderer/lib/utils'
import { labelChipColors } from '@/renderer/lib/label-color'
import type { BacklogLabel } from '@/types/backlog'

export function LabelChip({ label }: { readonly label: BacklogLabel }) {
  const colors = labelChipColors(label.color)
  return (
    <span
      data-slot="label-chip"
      title={label.name}
      className={cn('inline-block max-w-32 truncate rounded-full border border-border px-1.5 text-meta font-medium', colors === null && 'bg-muted text-foreground-secondary')}
      style={colors === null ? undefined : { background: colors.background, color: colors.text }}
    >
      {label.name}
    </span>
  )
}
