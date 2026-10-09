// The shared listbox the `/` and `@` lists both render from — presentation only; the textarea owns keyboard handling.
import type { ReactNode } from 'react'

export interface SuggestionRow {
  readonly key: string
  /** A row that cannot be selected still renders, but is skipped by selection — see `selectableKeys`. */
  readonly content: ReactNode
  readonly title?: string
}

export interface SuggestionListProps {
  readonly id: string
  readonly rows: readonly SuggestionRow[]
  readonly selectedIndex: number | null
  readonly selectableKeys: ReadonlySet<string>
  readonly onSelect: (key: string) => void
}

const ROW_HEIGHT = 36
const MAX_VISIBLE_ROWS = 8

export function SuggestionList({ id, rows, selectedIndex, selectableKeys, onSelect }: SuggestionListProps) {
  if (rows.length === 0) return null

  return (
    <div
      id={id}
      role="listbox"
      className="absolute bottom-full left-0 z-10 mb-1 w-full overflow-y-auto rounded-[8px] border border-border bg-popover text-popover-foreground shadow-md"
      style={{ maxHeight: ROW_HEIGHT * MAX_VISIBLE_ROWS }}
    >
      {rows.map((row, index) => {
        const selectable = selectableKeys.has(row.key)
        const isSelected = selectable && index === selectedIndex
        return (
          <div
            key={row.key}
            id={`${id}-option-${row.key}`}
            role="option"
            aria-selected={isSelected}
            title={row.title}
            onMouseDown={(event) => {
              // Keeps focus on the textarea — a plain click would blur it first.
              event.preventDefault()
              if (selectable) onSelect(row.key)
            }}
            className={`flex h-9 items-center gap-2 truncate px-2 text-small ${selectable ? 'cursor-pointer' : 'cursor-default text-muted-foreground'} ${isSelected ? 'bg-accent' : ''}`}
          >
            {row.content}
          </div>
        )
      })}
    </div>
  )
}
