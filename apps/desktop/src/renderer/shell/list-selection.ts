// One selection model for every row list, keyed by row key so a reorder keeps the right row selected. No `useEffect`.
import { useState } from 'react'
import type { MouseEvent } from 'react'

export function nextKey(keys: readonly string[], selected: string | null): string | null {
  if (keys.length === 0) return null
  if (selected === null) return keys[0] ?? null
  const index = keys.indexOf(selected)
  if (index === -1) return keys[0] ?? null
  return keys[Math.min(index + 1, keys.length - 1)] ?? null
}

export function prevKey(keys: readonly string[], selected: string | null): string | null {
  if (keys.length === 0) return null
  if (selected === null) return keys[0] ?? null
  const index = keys.indexOf(selected)
  if (index === -1) return keys[0] ?? null
  return keys[Math.max(index - 1, 0)] ?? null
}

export function reconcile(keys: readonly string[], selected: string | null): string | null {
  return selected !== null && keys.includes(selected) ? selected : null
}

export function listRowClass(selected: boolean): string {
  return selected ? 'outline-none bg-selection ring-2 ring-ring ring-inset' : 'outline-none'
}

interface RowProps {
  readonly 'data-row-key': string
  readonly tabIndex: 0
  readonly onFocus: () => void
  readonly onMouseDown: (event: MouseEvent) => void
  readonly className: string
}

interface UseListSelectionOptions {
  readonly value?: string | null
  readonly onChange?: (key: string | null) => void
  /** Pressing the selected row clears it, instead of keeping it selected. */
  readonly toggle?: boolean
}

interface ListSelection {
  readonly selectedKey: string | null
  select(key: string | null): void
  clear(): void
  /** Clears only if `key` is still selected when this runs — safe to call from a timeout without a stale closure, since it reads state functionally. */
  clearIfStill(key: string): void
  next(): void
  prev(): void
  rowProps(key: string): RowProps
}

function focusRow(key: string): void {
  const row = document.querySelector(`[data-row-key="${CSS.escape(key)}"]`)
  if (row instanceof HTMLElement) row.focus({ preventScroll: false })
}

export function useListSelection(keys: readonly string[], options: UseListSelectionOptions = {}): ListSelection {
  const [uncontrolled, setUncontrolled] = useState<string | null>(null)
  const controlled = options.value !== undefined
  const rawSelected = controlled ? (options.value ?? null) : uncontrolled
  const selectedKey = reconcile(keys, rawSelected)

  function set(key: string | null): void {
    if (controlled) options.onChange?.(key)
    else setUncontrolled(key)
  }

  function select(key: string | null): void {
    set(key)
  }

  function clear(): void {
    set(null)
  }

  function clearIfStill(key: string): void {
    if (controlled) {
      if (options.value === key) options.onChange?.(null)
      return
    }
    setUncontrolled((current) => (current === key ? null : current))
  }

  function moveTo(key: string | null): void {
    set(key)
    if (key !== null) focusRow(key)
  }

  function next(): void {
    moveTo(nextKey(keys, selectedKey))
  }

  function prev(): void {
    moveTo(prevKey(keys, selectedKey))
  }

  function rowProps(key: string): RowProps {
    const reselect = options.toggle === true && key === selectedKey
    return {
      'data-row-key': key,
      tabIndex: 0,
      onFocus: () => select(key),
      onMouseDown: (event) => {
        if (reselect) {
          // Without this the focus that follows the press would select the row again.
          event.preventDefault()
          clear()
          return
        }
        select(key)
      },
      className: listRowClass(key === selectedKey),
    }
  }

  return {
    selectedKey,
    select,
    clear,
    clearIfStill,
    next,
    prev,
    rowProps,
  }
}
