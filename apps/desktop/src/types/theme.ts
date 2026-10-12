export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export interface ThemeStoreDeps {
  readonly storage: Pick<Storage, 'getItem' | 'setItem'>
  // A simple shape a real MediaQueryList already satisfies structurally.
  readonly media: {
    readonly matches: boolean
    addEventListener(type: 'change', listener: () => void): void
    removeEventListener(type: 'change', listener: () => void): void
  }
  readonly root: Pick<HTMLElement, 'dataset'>
}
