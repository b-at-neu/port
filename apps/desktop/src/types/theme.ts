export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export interface ThemeStoreDeps {
  readonly storage: Pick<Storage, 'getItem' | 'setItem'>
  /** A simple shape, not `Pick<MediaQueryList, …>` — the DOM lib's own
   *  overloaded `addEventListener` makes a plain fake awkward to type, and
   *  the real `MediaQueryList` already satisfies this narrower one
   *  structurally. */
  readonly media: {
    readonly matches: boolean
    addEventListener(type: 'change', listener: () => void): void
    removeEventListener(type: 'change', listener: () => void): void
  }
  readonly root: Pick<HTMLElement, 'dataset'>
}
