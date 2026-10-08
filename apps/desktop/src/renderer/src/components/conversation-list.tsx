// Pinned to the bottom while near it, a floating "N new below" button
// otherwise, and rows above 500 reveal in chunks across animation frames.
import { useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { ConversationEntry } from './conversation-entry'
import type { LiveBlock } from '../../../shared/hosting/types'
import type { TranscriptEntry } from '../../../shared/sessions/transcript'

const NEAR_BOTTOM_PX = 64
const CHUNK_THRESHOLD = 500
const CHUNK_SIZE = 200

function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX
}

function liveSignature(block: LiveBlock | null): string {
  return block === null ? '' : `${block.blockId}:${String(block.text.length)}`
}

function LiveRow({ block }: { readonly block: LiveBlock }) {
  if (block.kind === 'thinking') return <div className="text-small text-muted-foreground">Thinking…</div>
  return (
    <div>
      <span className="mb-1 block text-meta font-medium text-muted-foreground">Claude</span>
      <pre className="overflow-x-auto font-sans text-body leading-[1.6] whitespace-pre-wrap">{block.text}</pre>
    </div>
  )
}

export interface ConversationListProps {
  readonly entries: readonly TranscriptEntry[]
  /** The absolute index `entries[0]` carries — `0` for a transcript read from
   *  the start, `firstIndex` for a session attached mid-window. */
  readonly baseIndex: number
  readonly live: LiveBlock | null
  /** Scrolled to and highlighted once, on the row's own mount — a later prop
   *  change never re-focuses anything. */
  readonly focusIndex: number | null
  /** Bumping this number scrolls to the bottom — the transcript header's own Jump to latest. */
  readonly jumpSignal?: number
}

export function ConversationList({ entries, baseIndex, live, focusIndex, jumpSignal }: ConversationListProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const wasNearBottomRef = useRef(true)
  const hasScrolledOnceRef = useRef(false)
  const revealingRef = useRef(false)
  const signatureRef = useRef('')
  const jumpSignalRef = useRef(jumpSignal)
  const [visibleCount, setVisibleCount] = useState(() => Math.min(entries.length, CHUNK_THRESHOLD))
  const [pendingBelow, setPendingBelow] = useState(0)

  function handleScroll(): void {
    const el = containerRef.current
    if (el === null) return
    wasNearBottomRef.current = isNearBottom(el)
    if (wasNearBottomRef.current && pendingBelow > 0) setPendingBelow(0)
  }

  function jumpToLatest(): void {
    const el = containerRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
    setPendingBelow(0)
  }

  // A fresh function identity every render, so React re-invokes it on every commit.
  function containerRefCallback(node: HTMLDivElement | null): void {
    containerRef.current = node
    if (node === null) return

    if (jumpSignal !== undefined && jumpSignal !== jumpSignalRef.current) {
      jumpSignalRef.current = jumpSignal
      jumpToLatest()
    }

    if (!hasScrolledOnceRef.current) {
      hasScrolledOnceRef.current = true
      if (focusIndex === null) node.scrollTop = node.scrollHeight
      signatureRef.current = `${String(entries.length)}|${liveSignature(live)}`
      return
    }

    if (visibleCount < entries.length) {
      if (entries.length - visibleCount <= CHUNK_SIZE) {
        setVisibleCount(entries.length)
      } else if (!revealingRef.current) {
        revealingRef.current = true
        requestAnimationFrame(() => {
          revealingRef.current = false
          setVisibleCount((count) => Math.min(entries.length, count + CHUNK_SIZE))
        })
      }
      return
    }

    const signature = `${String(entries.length)}|${liveSignature(live)}`
    if (signature === signatureRef.current) return
    signatureRef.current = signature

    if (wasNearBottomRef.current) {
      node.scrollTop = node.scrollHeight
      if (pendingBelow > 0) setPendingBelow(0)
    } else {
      setPendingBelow((count) => count + 1)
    }
  }

  function focusRowRef(node: HTMLDivElement | null): void {
    if (node === null || hasScrolledOnceRef.current) return
    hasScrolledOnceRef.current = true
    node.scrollIntoView({ block: 'center' })
    signatureRef.current = `${String(entries.length)}|${liveSignature(live)}`
  }

  const visibleEntries = entries.slice(0, visibleCount)

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={containerRefCallback} onScroll={handleScroll} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        {visibleEntries.map((entry, relativeIndex) => {
          const absoluteIndex = relativeIndex + baseIndex
          const isFocus = absoluteIndex === focusIndex
          return (
            <div key={entry.uuid} ref={isFocus ? focusRowRef : undefined} className={isFocus ? 'rounded-md ring-2 ring-ring' : undefined}>
              <ConversationEntry entry={entry} />
            </div>
          )
        })}
        {live !== null ? <LiveRow block={live} /> : null}
      </div>
      {pendingBelow > 0 ? (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-card px-3 py-1 text-small shadow-sm hover:bg-accent"
        >
          {pendingBelow} new below <ChevronDown aria-hidden="true" className="size-3.5" />
        </button>
      ) : null}
    </div>
  )
}
