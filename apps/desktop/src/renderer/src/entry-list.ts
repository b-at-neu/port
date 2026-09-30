// The append/patch/pin-to-bottom/jump list model (#219) — generalized out of
// transcript.ts's own live-follow behaviour so the on-disk transcript view
// and the live session view share one model, each with its own `baseIndex`:
// `0` for a transcript read from the start, `firstIndex` for a session
// attached mid-window. A trailing "live row" is this model's own addition —
// the session view's currently-streaming block, always the list's last
// child, with every appended row inserted before it rather than after.
import type { EntryPatch, TranscriptEntry } from '../../shared/sessions/transcript'
import type { LiveBlock } from '../../shared/hosting/types'
import { buildRow, text } from './entry-rows'

/** Above this many entries, the list is appended in slices across
 *  `requestAnimationFrame` calls rather than in one synchronous pass — the
 *  largest observed transcript renders roughly 3,500 rows. */
const CHUNK_THRESHOLD = 500
const CHUNK_SIZE = 200

/** Within this many pixels of the bottom counts as "already there" for the
 *  pin-to-bottom behaviour. */
const NEAR_BOTTOM_PX = 64

export interface EntryListParams {
  readonly list: HTMLElement
  readonly jumpButton: HTMLButtonElement
  /** The absolute index this list's own row `0` names — a `patch(...)`
   *  naming an index below this is silently ignored, since it targets a row
   *  this list was never given (evicted from the projector's own window, or
   *  earlier than a windowed attach's `firstIndex`). */
  readonly baseIndex: number
  /** The absolute index to scroll to, highlight, and expand once its row is
   *  built — read once, on construction; a later `append` never re-focuses
   *  anything. */
  readonly focusIndex: number | null
}

export interface EntryList {
  append(entries: readonly TranscriptEntry[]): void
  patch(patches: readonly EntryPatch[]): void
  rowAt(absoluteIndex: number): HTMLElement | undefined
  jumpToLatest(): void
  /** `null` removes the live row entirely. A non-null block with the same
   *  `blockId` as the current live row is a no-op here — `appendLive` is
   *  what grows it; a different (or first) `blockId` rebuilds the row from
   *  scratch, seeded with `block.text`. */
  setLive(block: LiveBlock | null): void
  /** Grows the current live row's own text by `chunk` — a no-op with no
   *  live row, or a `thinking` one (collapsed, no live text shown). Batches
   *  the pin-to-bottom scroll into one `requestAnimationFrame` regardless of
   *  how many chunks land before it fires. */
  appendLive(chunk: string): void
  /** Orphans any still-chunking `append` loop — called once, when the
   *  screen this list belongs to is torn down. */
  dispose(): void
}

export function createEntryList(params: EntryListParams): EntryList {
  const { list, jumpButton, baseIndex, focusIndex } = params
  let generation = 0
  const rows: (HTMLElement | undefined)[] = []
  const entries: TranscriptEntry[] = []
  let pendingBelow = 0

  let liveRow: HTMLElement | null = null
  let livePre: HTMLElement | null = null
  let liveBlockId: string | null = null
  let liveRafScheduled = false

  function isNearBottom(): boolean {
    return list.scrollHeight - list.scrollTop - list.clientHeight <= NEAR_BOTTOM_PX
  }

  function updateJumpButton(): void {
    if (pendingBelow > 0) {
      jumpButton.textContent = `${pendingBelow} new below ↓`
      jumpButton.hidden = false
    } else {
      jumpButton.hidden = true
    }
  }

  function buildAndInsertRow(relativeIndex: number): void {
    const entry = entries[relativeIndex]
    if (entry === undefined) return
    const row = buildRow(entry)
    const absoluteIndex = relativeIndex + baseIndex
    row.dataset.entryIndex = String(absoluteIndex)
    rows[relativeIndex] = row
    // `insertBefore(row, null)` is a plain append — exactly what every row
    // does when there is no live row yet.
    list.insertBefore(row, liveRow)

    if (absoluteIndex === focusIndex) {
      if (row instanceof HTMLDetailsElement) row.open = true
      row.classList.add('entry--focused')
      row.scrollIntoView({ block: 'center' })
    }
  }

  function appendRange(start: number, end: number, thisGeneration: number): void {
    const total = end - start
    if (total <= CHUNK_THRESHOLD) {
      for (let i = start; i < end; i++) buildAndInsertRow(i)
      return
    }
    let index = start
    function appendNext(): void {
      if (thisGeneration !== generation) return
      const sliceEnd = Math.min(end, index + CHUNK_SIZE)
      for (let i = index; i < sliceEnd; i++) buildAndInsertRow(i)
      index = sliceEnd
      if (index < end) requestAnimationFrame(appendNext)
    }
    appendNext()
  }

  return {
    append(newEntries) {
      if (newEntries.length === 0) return
      const wasAtBottom = isNearBottom()
      const start = entries.length
      entries.push(...newEntries)
      appendRange(start, entries.length, generation)

      if (wasAtBottom) {
        pendingBelow = 0
        updateJumpButton()
        requestAnimationFrame(() => {
          list.scrollTop = list.scrollHeight
        })
      } else {
        pendingBelow += newEntries.length
        updateJumpButton()
      }
    },

    patch(patches) {
      for (const patch of patches) {
        const relative = patch.index - baseIndex
        if (relative < 0) continue // targets a row below this list's own window
        entries[relative] = patch.entry
        const existingRow = rows[relative]
        if (existingRow === undefined) continue // not rendered yet -- appendRange picks up the patched entry when it gets there
        const newRow = buildRow(patch.entry)
        // Carries the row's open state across the swap -- an operator with a
        // tool call expanded must not have it silently collapse the moment
        // its result arrives.
        if (existingRow instanceof HTMLDetailsElement && newRow instanceof HTMLDetailsElement) {
          newRow.open = existingRow.open
        }
        existingRow.replaceWith(newRow)
        rows[relative] = newRow
      }
    },

    rowAt(absoluteIndex) {
      return rows[absoluteIndex - baseIndex]
    },

    jumpToLatest() {
      list.scrollTop = list.scrollHeight
      pendingBelow = 0
      updateJumpButton()
    },

    setLive(block) {
      if (block === null) {
        liveRow?.remove()
        liveRow = null
        livePre = null
        liveBlockId = null
        return
      }
      if (liveRow !== null && liveBlockId === block.blockId) return // appendLive already grows it

      liveRow?.remove()
      liveBlockId = block.blockId

      if (block.kind === 'thinking') {
        liveRow = text('div', 'entry entry--live entry--thinking-live', 'Thinking…')
        livePre = null
      } else {
        const wrap = document.createElement('div')
        wrap.className = 'entry entry--assistant entry--live'
        wrap.appendChild(text('span', 'entry__label', 'Claude'))
        const pre = document.createElement('pre')
        pre.className = 'entry__payload'
        pre.textContent = block.text
        wrap.appendChild(pre)
        liveRow = wrap
        livePre = pre
      }
      list.appendChild(liveRow)
    },

    appendLive(chunk) {
      if (livePre === null || chunk === '') return
      livePre.append(chunk)
      if (liveRafScheduled) return
      liveRafScheduled = true
      requestAnimationFrame(() => {
        liveRafScheduled = false
        if (isNearBottom()) list.scrollTop = list.scrollHeight
      })
    },

    dispose() {
      generation += 1 // orphans any in-flight chunked append loop
    },
  }
}
