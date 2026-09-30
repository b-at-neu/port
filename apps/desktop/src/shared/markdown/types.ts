// The renderer-safe node values `shared/markdown/block.ts`/`inline.ts` parse
// into (#92) — DOM construction is `renderer/src/markdown.ts`'s job alone;
// this file contains no browser or Node API and no markup string anywhere.
// Anything the block/inline parsers do not recognize (raw HTML, images,
// footnotes, reference links, deeper list nesting) is carried inside an
// ordinary `paragraph`'s own `text` inline nodes — rendered as literal
// characters via `textContent`, never dropped and never interpreted.
export type InlineNode =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'code'; readonly value: string }
  | { readonly kind: 'strong'; readonly children: readonly InlineNode[] }
  | { readonly kind: 'emphasis'; readonly children: readonly InlineNode[] }
  /** Emitted only for an `http://`/`https://` href (`inline.ts`'s own scheme
   *  allowlist) — every other scheme renders as the literal `[text](href)`
   *  text instead, since a `javascript:` href in an Electron renderer is a
   *  code-execution sink and a relative GitHub path would be broken anyway. */
  | { readonly kind: 'link'; readonly text: string; readonly href: string }

export interface ListItem {
  readonly inline: readonly InlineNode[]
  /** `null` for an ordinary list item, `true`/`false` for a GitHub task item
   *  (`- [ ]`/`- [x]`). */
  readonly checked: boolean | null
  /** One level of nesting only, the plan's own bounded subset — a nested
   *  list under this item, or `[]` when there is none. */
  readonly children: readonly BlockNode[]
}

export type TableAlign = 'left' | 'center' | 'right' | null

/** One table cell's own inline run — a row is `readonly TableCell[]`, a
 *  table's `rows` a `readonly TableRow[]`, so the nesting reads the same way
 *  three levels deep as it does one. */
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
