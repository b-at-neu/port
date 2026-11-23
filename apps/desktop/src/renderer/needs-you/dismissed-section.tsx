// The Show dismissed view: every dismissed item that still derives, each with Restore.
import { Button } from '@/renderer/components/ui/button'
import { NeedsYouItem } from '@/renderer/components/needs-you-item'
import { DISMISSED_LABEL, RESTORE_ALL_LABEL, RESTORE_LABEL, needsYouLeadCopy } from '@/renderer/needs-you/copy'
import { dismissKeyOf } from '@/renderer/needs-you/dismiss-key'
import type { NeedsYouItem as NeedsYouItemModel } from '@/types/board'

export function DismissedSection({ items, now, onRestore }: { readonly items: readonly NeedsYouItemModel[]; readonly now: Date; readonly onRestore: (items: readonly NeedsYouItemModel[]) => void }) {
  return (
    <section aria-label={DISMISSED_LABEL}>
      <div className="flex h-9 items-center justify-between border-b border-border px-4 text-meta text-muted-foreground">
        <span>
          {DISMISSED_LABEL} · {items.length}
        </span>
        <Button variant="ghost" size="small" onClick={() => onRestore(items)}>
          {RESTORE_ALL_LABEL}
        </Button>
      </div>
      {items.map((item) => (
        <NeedsYouItem
          key={dismissKeyOf(item)}
          leadCopy={needsYouLeadCopy(item, now)}
          repo={item.repo}
          at={item.at}
          now={now}
          actionLabel={RESTORE_LABEL}
          actionDisabledReason={null}
          actionPending={false}
          onAction={() => onRestore([item])}
          expandable={false}
          expanded={false}
          onToggleExpand={() => undefined}
        />
      ))}
    </section>
  )
}
