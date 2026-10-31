/** Injectable so tests exercise against a plain fake, never a jsdom `window`. */
export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}
