// The renderer-safe node values block.ts/inline.ts parse into — rendering is `markdown.tsx`'s job alone. Anything unrecognized carries through as an ordinary paragraph's literal text node.
export type InlineNode =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'code'; readonly value: string }
  | { readonly kind: 'strong'; readonly children: readonly InlineNode[] }
  | { readonly kind: 'emphasis'; readonly children: readonly InlineNode[] }
  /** Emitted only for an `http://`/`https://` href; every other scheme renders as literal `[text](href)` text instead. */
  | { readonly kind: 'link'; readonly text: string; readonly href: string }

export interface ListItem {
  readonly inline: readonly InlineNode[]
  /** `null` for an ordinary list item, `true`/`false` for a GitHub task item. */
  readonly checked: boolean | null
  /** One level of nesting only — a nested list under this item, or `[]` when there is none. */
  readonly children: readonly BlockNode[]
}

export type TableAlign = 'left' | 'center' | 'right' | null

/** One table cell's own inline run, nesting the same way three levels deep as it does one. */
export type TableCell = readonly InlineNode[]
export type TableRow = readonly TableCell[]

export type BlockNode =
  | { readonly kind: 'heading'; readonly level: 1 | 2 | 3 | 4 | 5 | 6; readonly inline: readonly InlineNode[] }
  | { readonly kind: 'paragraph'; readonly inline: readonly InlineNode[] }
  | { readonly kind: 'code'; readonly language: string | null; readonly code: string }
  | { readonly kind: 'blockquote'; readonly children: readonly BlockNode[] }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly ListItem[] }
  | { readonly kind: 'table'; readonly header: TableRow; readonly align: readonly TableAlign[]; readonly rows: readonly TableRow[] }
  | { readonly kind: 'thematic-break' }
