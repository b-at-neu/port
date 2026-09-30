import { describe, expect, it } from 'vitest'
import { parseMarkdown } from './block'

describe('parseMarkdown — headings', () => {
  it('parses an ATX heading at every level', () => {
    for (let level = 1; level <= 6; level++) {
      const hashes = '#'.repeat(level)
      expect(parseMarkdown(`${hashes} Title`)).toEqual([{ kind: 'heading', level, inline: [{ kind: 'text', value: 'Title' }] }])
    }
  })
})

describe('parseMarkdown — paragraphs', () => {
  it('joins consecutive non-blank lines into one paragraph, separated by a space', () => {
    expect(parseMarkdown('line one\nline two')).toEqual([{ kind: 'paragraph', inline: [{ kind: 'text', value: 'line one line two' }] }])
  })

  it('splits two paragraphs on a blank line', () => {
    const result = parseMarkdown('first\n\nsecond')
    expect(result).toEqual([
      { kind: 'paragraph', inline: [{ kind: 'text', value: 'first' }] },
      { kind: 'paragraph', inline: [{ kind: 'text', value: 'second' }] },
    ])
  })
})

describe('parseMarkdown — fenced code', () => {
  it('parses a fenced code block with a language tag, verbatim, no inline parsing', () => {
    const src = ['```ts', 'const x = 1', '**not bold**', '```'].join('\n')
    expect(parseMarkdown(src)).toEqual([{ kind: 'code', language: 'ts', code: 'const x = 1\n**not bold**' }])
  })

  it('parses a fenced code block with no language tag', () => {
    const src = ['```', 'plain', '```'].join('\n')
    expect(parseMarkdown(src)).toEqual([{ kind: 'code', language: null, code: 'plain' }])
  })
})

describe('parseMarkdown — blockquote', () => {
  it('parses a blockquote, recursively parsing its own content', () => {
    const src = ['> a quoted line', '> ## Nested heading'].join('\n')
    expect(parseMarkdown(src)).toEqual([
      {
        kind: 'blockquote',
        children: [
          { kind: 'paragraph', inline: [{ kind: 'text', value: 'a quoted line' }] },
          { kind: 'heading', level: 2, inline: [{ kind: 'text', value: 'Nested heading' }] },
        ],
      },
    ])
  })
})

describe('parseMarkdown — lists', () => {
  it('parses an unordered list', () => {
    const src = ['- one', '- two'].join('\n')
    expect(parseMarkdown(src)).toEqual([
      { kind: 'list', ordered: false, items: [{ inline: [{ kind: 'text', value: 'one' }], checked: null, children: [] }, { inline: [{ kind: 'text', value: 'two' }], checked: null, children: [] }] },
    ])
  })

  it('parses an ordered list', () => {
    const src = ['1. first', '2. second'].join('\n')
    const result = parseMarkdown(src)
    expect(result).toEqual([
      { kind: 'list', ordered: true, items: [{ inline: [{ kind: 'text', value: 'first' }], checked: null, children: [] }, { inline: [{ kind: 'text', value: 'second' }], checked: null, children: [] }] },
    ])
  })

  it('parses GitHub task items, checked and unchecked', () => {
    const src = ['- [ ] todo', '- [x] done'].join('\n')
    const result = parseMarkdown(src)
    expect(result).toEqual([
      { kind: 'list', ordered: false, items: [{ inline: [{ kind: 'text', value: 'todo' }], checked: false, children: [] }, { inline: [{ kind: 'text', value: 'done' }], checked: true, children: [] }] },
    ])
  })

  it('parses one level of nesting under a list item', () => {
    const src = ['- parent', '  - child one', '  - child two', '- sibling'].join('\n')
    const result = parseMarkdown(src)
    expect(result).toEqual([
      {
        kind: 'list',
        ordered: false,
        items: [
          {
            inline: [{ kind: 'text', value: 'parent' }],
            checked: null,
            children: [
              {
                kind: 'list',
                ordered: false,
                items: [
                  { inline: [{ kind: 'text', value: 'child one' }], checked: null, children: [] },
                  { inline: [{ kind: 'text', value: 'child two' }], checked: null, children: [] },
                ],
              },
            ],
          },
          { inline: [{ kind: 'text', value: 'sibling' }], checked: null, children: [] },
        ],
      },
    ])
  })
})

describe('parseMarkdown — thematic break', () => {
  it.each(['---', '***', '___'])('parses %s as a thematic break', (line) => {
    expect(parseMarkdown(line)).toEqual([{ kind: 'thematic-break' }])
  })
})

describe('parseMarkdown — GFM pipe tables', () => {
  it('parses a header, an alignment row, and data rows', () => {
    const src = ['| Decision | add | remove |', '| --- | :--- | ---: |', '| approve | planApproved | planReview |'].join('\n')
    const result = parseMarkdown(src)
    expect(result).toEqual([
      {
        kind: 'table',
        header: [[{ kind: 'text', value: 'Decision' }], [{ kind: 'text', value: 'add' }], [{ kind: 'text', value: 'remove' }]],
        align: [null, 'left', 'right'],
        rows: [[[{ kind: 'text', value: 'approve' }], [{ kind: 'text', value: 'planApproved' }], [{ kind: 'text', value: 'planReview' }]]],
      },
    ])
  })

  it('falls back to a paragraph when the second line is not a delimiter row', () => {
    const src = ['| a | b |', '| c | d |'].join('\n')
    const result = parseMarkdown(src)
    expect(result.every((node) => node.kind !== 'table')).toBe(true)
  })
})

describe('parseMarkdown — the unsupported-syntax fallthrough', () => {
  it('renders raw HTML as literal paragraph text, never as a parsed element', () => {
    const result = parseMarkdown('before <b>bold</b> after')
    expect(result).toEqual([{ kind: 'paragraph', inline: [{ kind: 'text', value: 'before <b>bold</b> after' }] }])
  })

  it('renders an image as literal text, never a link or an image node', () => {
    const result = parseMarkdown('![alt text](https://example.com/x.png)')
    expect(result).toEqual([{ kind: 'paragraph', inline: [{ kind: 'text', value: '![alt text](https://example.com/x.png)' }] }])
  })

  it('renders a footnote reference as literal text', () => {
    const result = parseMarkdown('a claim[^1]')
    expect(result).toEqual([{ kind: 'paragraph', inline: [{ kind: 'text', value: 'a claim[^1]' }] }])
  })
})
