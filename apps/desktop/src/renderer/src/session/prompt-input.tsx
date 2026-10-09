// Wires the composer's input paths for one session: the `/`/`@` trigger and suggestion list, attachments, and prompt history.
import { useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Composer } from '../components/composer'
import type { ComposerAttachmentChip } from '../components/composer'
import { SuggestionList } from '../components/suggestion-list'
import type { SuggestionRow } from '../components/suggestion-list'
import { useIpcQuery } from '../data/query'
import type { RepoId } from '../../../shared/repos'
import type { ComposerAttachment } from '../../../shared/hosting/attachments'
import type { HostedSessionSnapshot, SessionKey, SlashCommandSummary } from '../../../shared/hosting/types'
import { activeTrigger, applySuggestion, fuzzyRankFiles, rankCommands } from './composer-model'
import { checkBatchLimits, readAttachment, sizeNotice } from './attachments'
import type { FileLike } from './attachments'
import { historyFor, NOT_RECALLING, recallNewer, recallOlder, recallText, recordSent } from './prompt-history'
import type { RecallState } from './prompt-history'
import {
  COMMANDS_UNAVAILABLE,
  filesTruncatedNote,
  FILES_UNREADABLE,
  LOADING_COMMANDS,
  LOADING_FILES,
  NO_MATCHING_COMMANDS,
  NO_MATCHING_FILES,
} from './composer-copy'
import { draftAttachmentsFor, setDraft, setDraftAttachments, useDraft, useDraftAttachments } from './drafts'

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function attachmentBytes(attachment: ComposerAttachment): number {
  if (attachment.kind === 'text') return new TextEncoder().encode(attachment.text).length
  // base64 -> byte estimate, the same formula the main-process validator uses.
  const data = attachment.data
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.max(0, (data.length / 4) * 3 - padding)
}

function chipKey(attachment: ComposerAttachment, index: number): string {
  return `${String(index)}-${attachment.name}`
}

function toChip(attachment: ComposerAttachment, index: number): ComposerAttachmentChip {
  return { key: chipKey(attachment, index), name: attachment.name, kind: attachment.kind, sizeLabel: sizeLabel(attachmentBytes(attachment)) }
}

function readerDeps() {
  return {
    readAsDataUrl: (file: File) =>
      new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
        reader.onerror = () => reject(reader.error ?? new Error('read failed'))
        reader.readAsDataURL(file)
      }),
    readAsText: (file: File) => file.text(),
  }
}

export interface PromptInputProps {
  readonly sessionKey: SessionKey
  readonly repoId: RepoId
  readonly snapshot: HostedSessionSnapshot
  readonly disabled: boolean
  readonly placeholder: string
  readonly sendLabel: string | null
  readonly onSend: (text: string, attachments: readonly ComposerAttachment[]) => void
  readonly onEscape?: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  // Shift+Tab cycles the permission mode; left unset, Tab keeps its ordinary focus-move behaviour.
  readonly onShiftTab?: () => void
  readonly autoFocus?: boolean
}

export function PromptInput({ sessionKey, repoId, snapshot, disabled, placeholder, sendLabel, onSend, onEscape, onShiftTab, autoFocus }: PromptInputProps) {
  const draft = useDraft(sessionKey)
  const attachments = useDraftAttachments(sessionKey)
  const [caret, setCaret] = useState(0)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [recall, setRecall] = useState<RecallState>(NOT_RECALLING)
  const [notice, setNotice] = useState<string | null>(null)

  const trigger = activeTrigger(draft, caret)
  const filesQuery = useIpcQuery('session:files', { sessionKey }, { enabled: trigger?.kind === 'file' })

  const capabilities = snapshot.capabilities

  const rankedCommands = useMemo(() => {
    if (trigger?.kind !== 'command') return []
    const slashCommands: readonly SlashCommandSummary[] = capabilities.kind === 'ready' ? capabilities.slashCommands : []
    return rankCommands(slashCommands, trigger.query)
  }, [trigger, capabilities])
  const rankedFiles = useMemo(
    () => (trigger?.kind === 'file' && filesQuery.data?.ok === true ? fuzzyRankFiles(filesQuery.data.files, trigger.query) : []),
    [trigger, filesQuery.data],
  )

  function accept(name: string): void {
    if (trigger === null) return
    const result = applySuggestion(draft, trigger, name)
    setDraft(sessionKey, result.value)
    setCaret(result.caret)
  }

  const listId = `composer-suggestions-${sessionKey}`

  function buildRows(): { rows: SuggestionRow[]; selectableKeys: Set<string> } {
    const selectableKeys = new Set<string>()
    if (trigger === null) return { rows: [], selectableKeys }

    if (trigger.kind === 'command') {
      if (capabilities.kind === 'pending') return { rows: [{ key: '_loading', content: LOADING_COMMANDS }], selectableKeys }
      if (capabilities.kind === 'unavailable') return { rows: [{ key: '_unavailable', content: COMMANDS_UNAVAILABLE }], selectableKeys }
      if (rankedCommands.length === 0) return { rows: [{ key: '_empty', content: NO_MATCHING_COMMANDS }], selectableKeys }
      const rows = rankedCommands.map((command) => {
        selectableKeys.add(command.name)
        return { key: command.name, title: command.argumentHint, content: <CommandRow command={command} /> }
      })
      return { rows, selectableKeys }
    }

    if (filesQuery.status === 'pending') return { rows: [{ key: '_loading', content: LOADING_FILES }], selectableKeys }
    if (filesQuery.data?.ok === false) return { rows: [{ key: '_error', content: FILES_UNREADABLE }], selectableKeys }
    if (rankedFiles.length === 0) return { rows: [{ key: '_empty', content: NO_MATCHING_FILES }], selectableKeys }
    const rows: SuggestionRow[] = rankedFiles.map((path) => {
      selectableKeys.add(path)
      return { key: path, content: <FileRow path={path} /> }
    })
    if (filesQuery.data?.ok === true && filesQuery.data.truncated) rows.push({ key: '_truncated', content: filesTruncatedNote(filesQuery.data.files.length) })
    return { rows, selectableKeys }
  }

  const { rows: suggestionRows, selectableKeys } = buildRows()
  const selectableOrder = suggestionRows.filter((row) => selectableKeys.has(row.key)).map((row) => row.key)
  const selectedKey = selectableOrder[selectedIndex] ?? null
  const triggerOpen = trigger !== null && suggestionRows.length > 0

  function moveSelection(delta: number): void {
    if (selectableOrder.length === 0) return
    setSelectedIndex((index) => (index + delta + selectableOrder.length) % selectableOrder.length)
  }

  function atRecallBoundary(history: readonly string[]): boolean {
    return draft === '' || (recall.index !== null && recallText(history, recall) === draft)
  }

  function handleKeyDownBefore(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (triggerOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        moveSelection(1)
        return true
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        moveSelection(-1)
        return true
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && selectedKey !== null) {
        event.preventDefault()
        accept(selectedKey)
        return true
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setCaret(-1) // moves the caret state out of the trigger's own range, closing the list
        return true
      }
      // No selectable row (loading/unavailable/empty): Enter falls through and sends the draft as typed.
      return false
    }

    const history = historyFor(repoId)
    if (event.key === 'ArrowUp' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey && atRecallBoundary(history)) {
      event.preventDefault()
      const next = recallOlder(history, recall)
      setRecall(next)
      setDraft(sessionKey, recallText(history, next) ?? '')
      return true
    }
    if (event.key === 'ArrowDown' && recall.index !== null && recallText(history, recall) === draft) {
      event.preventDefault()
      const next = recallNewer(recall)
      setRecall(next)
      setDraft(sessionKey, recallText(history, next) ?? '')
      return true
    }

    return false
  }

  function handleFiles(files: readonly File[]): void {
    const likeFiles: FileLike[] = files.map((file) => ({ name: file.name, size: file.size, type: file.type }))
    const totalBytes = attachments.reduce((sum, a) => sum + attachmentBytes(a), 0)
    const check = checkBatchLimits(attachments.length, totalBytes, likeFiles)
    const notices = check.rejected.map((rejection) => rejection.notice)
    const acceptedFiles = files.filter((file) => check.accepted.some((like) => like.name === file.name && like.size === file.size))

    void Promise.all(
      acceptedFiles.map(async (file) => {
        const oversize = sizeNotice({ name: file.name, size: file.size, type: file.type })
        if (oversize !== null) {
          notices.push(oversize)
          return null
        }
        const result = await readAttachment(file, readerDeps())
        if (!result.ok) {
          notices.push(result.notice)
          return null
        }
        return result.attachment
      }),
    ).then((results) => {
      const accepted = results.filter((attachment): attachment is ComposerAttachment => attachment !== null)
      if (accepted.length > 0) setDraftAttachments(sessionKey, [...draftAttachmentsFor(sessionKey), ...accepted])
      setNotice(notices.length > 0 ? notices.join(' ') : null)
    })
  }

  function handleSend(): void {
    setNotice(null)
    setRecall(NOT_RECALLING)
    if (draft.trim() !== '') recordSent(repoId, draft.trim())
    onSend(draft, attachments)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Composer
        value={draft}
        onChange={(value) => {
          setDraft(sessionKey, value)
          setCaret(value.length)
          setSelectedIndex(0)
        }}
        onSend={handleSend}
        onEscape={onEscape}
        onShiftTab={onShiftTab}
        disabled={disabled}
        placeholder={placeholder}
        sendLabel={sendLabel}
        autoFocus={autoFocus}
        attachments={attachments.map(toChip)}
        onRemoveAttachment={(key) => setDraftAttachments(sessionKey, attachments.filter((attachment, index) => chipKey(attachment, index) !== key))}
        onFiles={handleFiles}
        onKeyDownBefore={handleKeyDownBefore}
        combobox={{ listId, expanded: triggerOpen, activeDescendantId: selectedKey !== null ? `${listId}-option-${selectedKey}` : null }}
        suggestionList={triggerOpen ? <SuggestionList id={listId} rows={suggestionRows} selectedIndex={selectedIndex} selectableKeys={selectableKeys} onSelect={accept} /> : null}
      />
      {notice !== null ? (
        <p aria-live="polite" className="text-meta text-danger-pill-foreground">
          {notice}
        </p>
      ) : null}
    </div>
  )
}

function CommandRow({ command }: { readonly command: SlashCommandSummary }) {
  return (
    <>
      <span className="font-mono">/{command.name}</span>
      <span className="truncate text-muted-foreground">{command.description}</span>
    </>
  )
}

function FileRow({ path }: { readonly path: string }) {
  const lastSlash = path.lastIndexOf('/')
  const base = lastSlash === -1 ? path : path.slice(lastSlash + 1)
  const dir = lastSlash === -1 ? '' : path.slice(0, lastSlash)
  return (
    <>
      <span className="truncate">{base}</span>
      {dir !== '' ? (
        <span className="truncate text-muted-foreground" style={{ direction: 'rtl' }}>
          {dir}
        </span>
      ) : null}
    </>
  )
}
