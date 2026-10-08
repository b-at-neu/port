// Enter sends, Shift+Enter makes a new line; Esc is the caller's own concern.
import type { KeyboardEvent } from 'react'
import { Send } from 'lucide-react'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'

export interface ComposerProps {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly onSend: () => void
  readonly onEscape?: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  readonly disabled: boolean
  readonly placeholder: string
  /** `null` hides the send button entirely (closing, ended). */
  readonly sendLabel: string | null
  readonly autoFocus?: boolean
}

export function Composer({ value, onChange, onSend, onEscape, disabled, placeholder, sendLabel, autoFocus }: ComposerProps) {
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Escape') {
      onEscape?.(event)
      return
    }
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (value.trim() !== '') onSend()
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (value.trim() !== '') onSend()
      }}
      className="flex items-end gap-2 rounded-[10px] border border-border bg-card p-2"
    >
      <Textarea
        autoFocus={autoFocus}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder={placeholder}
        rows={2}
        className="min-h-9 flex-1 resize-none border-0 bg-transparent px-2 py-1.5 focus-visible:ring-0"
      />
      {sendLabel !== null ? (
        <Button type="submit" size="small" disabled={disabled || value.trim() === ''} aria-label={sendLabel}>
          <Send aria-hidden="true" className="size-3.5" />
          {sendLabel}
        </Button>
      ) : null}
    </form>
  )
}
