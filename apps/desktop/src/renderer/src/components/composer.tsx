// Enter sends, Shift+Enter makes a new line; Esc is the caller's own concern.
// Attachments, paste/drop/paperclip, and the combobox contract are all optional props.
import { useRef, useState } from 'react'
import type { ClipboardEvent, DragEvent, KeyboardEvent, ReactNode } from 'react'
import { FileText, Image as ImageIcon, Paperclip, Send, X } from 'lucide-react'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { ATTACH_FILES_TOOLTIP, DROP_TO_ATTACH_HINT, removeAttachmentLabel } from '../session/composer-copy'

export interface ComposerAttachmentChip {
  readonly key: string
  readonly name: string
  readonly kind: 'image' | 'pdf' | 'text'
  readonly sizeLabel: string
}

export interface ComposerComboboxProps {
  readonly listId: string
  readonly expanded: boolean
  readonly activeDescendantId: string | null
}

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
  // Shift+Tab cycles the permission mode; left unset, Tab keeps its ordinary focus-move behaviour.
  readonly onShiftTab?: () => void
  /** The draft's own chip row, rendered above the textarea only while non-empty. */
  readonly attachments?: readonly ComposerAttachmentChip[]
  readonly onRemoveAttachment?: (key: string) => void
  /** Pasted, dropped, or paperclip-picked files — classifying and reading them is the caller's own job. */
  readonly onFiles?: (files: readonly File[]) => void
  /** Runs before Enter/Esc handling; `true` means it already handled the key. */
  readonly onKeyDownBefore?: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean
  readonly combobox?: ComposerComboboxProps
  /** The suggestion list, floated above the composer by its own caller. */
  readonly suggestionList?: ReactNode
}

function attachmentIcon(kind: ComposerAttachmentChip['kind']) {
  return kind === 'text' ? <FileText aria-hidden="true" className="size-3.5" /> : <ImageIcon aria-hidden="true" className="size-3.5" />
}

export function Composer({
  value,
  onChange,
  onSend,
  onEscape,
  disabled,
  placeholder,
  sendLabel,
  autoFocus,
  onShiftTab,
  attachments = [],
  onRemoveAttachment,
  onFiles,
  onKeyDownBefore,
  combobox,
  suggestionList,
}: ComposerProps) {
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const canSend = !disabled && (value.trim() !== '' || attachments.length > 0)

  function trySend(): void {
    if (canSend) onSend()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (onKeyDownBefore?.(event) === true) return
    if (event.key === 'Escape') {
      onEscape?.(event)
      return
    }
    if (event.key === 'Tab' && event.shiftKey && onShiftTab !== undefined) {
      event.preventDefault()
      onShiftTab()
      return
    }
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    trySend()
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const files = Array.from(event.clipboardData.files)
    if (files.length > 0) onFiles?.(files)
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    setDragging(false)
    const files = Array.from(event.dataTransfer.files)
    if (files.length > 0) onFiles?.(files)
  }

  return (
    <div
      className="relative flex flex-col gap-1.5"
      onDragOver={(event) => {
        if (onFiles === undefined) return
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      {suggestionList}
      {attachments.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {attachments.map((attachment) => (
            <span key={attachment.key} className="flex items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-meta">
              {attachmentIcon(attachment.kind)}
              <span className="max-w-40 truncate">{attachment.name}</span>
              <span className="text-muted-foreground">{attachment.sizeLabel}</span>
              <button
                type="button"
                aria-label={removeAttachmentLabel(attachment.name)}
                onClick={() => onRemoveAttachment?.(attachment.key)}
                className="rounded outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X aria-hidden="true" className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          trySend()
        }}
        className={`flex items-end gap-2 rounded-[10px] border p-2 ${dragging ? 'border-ring ring-2 ring-ring' : 'border-border'} bg-card`}
      >
        {onFiles !== undefined ? (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                const files = Array.from(event.target.files ?? [])
                if (files.length > 0) onFiles(files)
                event.target.value = ''
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="small"
              disabled={disabled}
              aria-label={ATTACH_FILES_TOOLTIP}
              title={ATTACH_FILES_TOOLTIP}
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip aria-hidden="true" className="size-3.5" />
            </Button>
          </>
        ) : null}
        <Textarea
          autoFocus={autoFocus}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={onFiles !== undefined ? handlePaste : undefined}
          disabled={disabled}
          placeholder={dragging ? DROP_TO_ATTACH_HINT : placeholder}
          rows={2}
          role={combobox !== undefined ? 'combobox' : undefined}
          aria-expanded={combobox?.expanded}
          aria-controls={combobox?.listId}
          aria-activedescendant={combobox?.activeDescendantId ?? undefined}
          className="min-h-9 flex-1 resize-none border-0 bg-transparent px-2 py-1.5 focus-visible:ring-0"
        />
        {sendLabel !== null ? (
          <Button type="submit" size="small" disabled={!canSend} aria-label={sendLabel}>
            <Send aria-hidden="true" className="size-3.5" />
            {sendLabel}
          </Button>
        ) : null}
      </form>
    </div>
  )
}
