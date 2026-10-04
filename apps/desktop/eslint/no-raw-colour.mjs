// The local port/no-raw-colour rule (#316) — DESIGN.md §1: "components use
// roles, never values." No imports (ENGINEERING §1's self-contained-file
// rule, applied here even though this file is never copied alone, so a
// dynamic import from scripts/checks/desktop-react.ts stays dependency-free).
//
// COLOUR_PATTERNS is what this ESLint rule tests string Literal and
// TemplateElement values against. CSS_COLOUR_PATTERNS is the sibling set
// scripts/checks/desktop-react.ts uses to scan .css file text directly —
// neither this rule nor that check is a parser, both are regex heuristics
// broken deliberately once (ENGINEERING §7) against each pattern's own
// `good`/`bad` pair.

/**
 * A whole-literal hex colour — anchored to the *entire* string, and
 * deliberately 6/8 digits only. This repository's own prose constantly
 * writes a 3-digit-shaped issue reference ("fixed in #305"); matching the
 * short form too would flag every one of those as a colour.
 */
const HEX_LITERAL = {
  id: 'hex-literal',
  source: '^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$',
  flags: '',
  message: 'Raw hex colour literal — use a DESIGN.md §1 role, never a literal value.',
  good: '#305',
  bad: '#172554',
}

const COLOUR_FUNCTION_SOURCE = '\\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\\('

const COLOUR_FUNCTION = {
  id: 'colour-function',
  source: COLOUR_FUNCTION_SOURCE,
  flags: '',
  message: 'Raw CSS colour function — use a DESIGN.md §1 role, never a literal value.',
  good: 'text-body',
  bad: 'rgb(23, 23, 27)',
}

const TAILWIND_ARBITRARY_COLOUR = {
  id: 'tailwind-arbitrary-colour',
  source: '-\\[(#|rgb\\(|color:)',
  flags: '',
  message: 'Tailwind arbitrary colour value — use a DESIGN.md §1 role utility instead.',
  good: 'bg-background',
  bad: 'bg-[#172554]',
}

const TAILWIND_PALETTE_COLOUR = {
  id: 'tailwind-palette-colour',
  source:
    '\\b(?:bg|text|border|ring|fill|stroke|from|via|to|accent|caret|decoration|outline|shadow|divide|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white)(?:-(?:50|100|200|300|400|500|600|700|800|900|950))?\\b',
  flags: '',
  message: "Tailwind's default palette class — this app's theme drops the default palette (theme.css); use a DESIGN.md §1 role instead.",
  good: 'bg-background',
  bad: 'text-zinc-500',
}

export const COLOUR_PATTERNS = [HEX_LITERAL, COLOUR_FUNCTION, TAILWIND_ARBITRARY_COLOUR, TAILWIND_PALETTE_COLOUR]

export const CSS_COLOUR_PATTERNS = [
  {
    id: 'css-hex-value',
    // A hex value in property-value position — never a selector such as
    // `#app`, which carries no preceding colon.
    source: ':\\s*#[0-9a-fA-F]{3,8}\\b',
    flags: '',
    message: 'Raw hex colour value in CSS — only styles/theme.css may hold colour values.',
    good: '#app { display: flex; }',
    bad: 'color: #172554;',
  },
  {
    id: 'css-colour-function',
    source: ':\\s*[^;]*' + COLOUR_FUNCTION_SOURCE,
    flags: '',
    message: 'Raw CSS colour function — only styles/theme.css may hold colour values.',
    good: 'color: var(--foreground);',
    bad: 'color: rgb(23, 23, 27);',
  },
]

function firstMatch(value, patterns) {
  for (const pattern of patterns) {
    if (new RegExp(pattern.source, pattern.flags).test(value)) return pattern
  }
  return null
}

export const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallows raw colour values in renderer source — DESIGN.md §1 roles only.' },
    schema: [],
    messages: Object.fromEntries(COLOUR_PATTERNS.map((pattern) => [pattern.id, pattern.message])),
  },
  create(context) {
    function check(node, value) {
      const match = firstMatch(value, COLOUR_PATTERNS)
      if (match !== null) context.report({ node, messageId: match.id })
    }
    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value)
      },
      TemplateElement(node) {
        check(node, node.value.raw)
      },
    }
  },
}
