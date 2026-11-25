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

export const KEEPS_SELECTION = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  '[contenteditable="true"]',
  '[role="button"]:not([data-row-key])',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="combobox"]',
  '[data-keeps-selection]',
].join(', ')

export type PressZone = 'row' | 'keep' | 'blank' | 'outside'

/** Only a primary press on the selected row, away from any control inside it, clears it. */
export function clearsOnPress(key: string, selected: string | null, button: number, onControl: boolean): boolean {
  return !onControl && key === selected && button === 0
}

export function clearsOnSurfacePress(zone: PressZone, button: number, selected: string | null): boolean {
  return zone === 'blank' && button === 0 && selected !== null
}

export interface PressNode {
  closest(selectors: string): PressNode | null
  contains(other: PressNode | Node | null): boolean
}

export function pressedControl(target: PressNode | null, row: PressNode): boolean {
  if (target === null) return false
  if (!row.contains(target)) return true
  const control = target.closest(KEEPS_SELECTION)
  return control !== null && control !== row
}

/** A press on a control inside the row, or one that reached the row through a portal, never on the row itself. */
export function isControlPress(event: MouseEvent): boolean {
  return pressedControl(event.target instanceof Element ? event.target : null, event.currentTarget)
}

export function pressZone(event: MouseEvent, surface: HTMLElement): PressZone {
  const target = event.target
  if (!(target instanceof Node) || !surface.contains(target)) return 'outside'
  if (target instanceof HTMLElement && (event.nativeEvent.offsetX >= target.clientWidth || event.nativeEvent.offsetY >= target.clientHeight)) return 'keep'
  const element = target instanceof Element ? target : target.parentElement
  if (element === null) return 'blank'
  const row = element.closest('[data-row-key]')
  if (row !== null && surface.contains(row)) return 'row'
  const control = element.closest(KEEPS_SELECTION)
  if (control !== null && surface.contains(control)) return 'keep'
  return 'blank'
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
}

interface SurfaceProps {
  onMouseDown: (event: MouseEvent<HTMLElement>) => void
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
  /** Spread on the element spanning the page: a press on empty space clears the selection. */
  surfaceProps(): SurfaceProps
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
    return {
      'data-row-key': key,
      tabIndex: 0,
      onFocus: () => select(key),
      onMouseDown: (event) => {
        if (clearsOnPress(key, selectedKey, event.button, isControlPress(event))) {
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

  function surfaceProps(): SurfaceProps {
    return {
      onMouseDown: (event) => {
        if (clearsOnSurfacePress(pressZone(event, event.currentTarget), event.button, selectedKey)) clear()
      },
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
    surfaceProps,
  }
}
