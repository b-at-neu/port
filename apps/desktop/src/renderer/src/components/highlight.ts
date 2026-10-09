// lowlight to token runs — a fixed language set, no auto-detection. An unknown or absent
// language, or code over MAX_HIGHLIGHT_CHARS, renders as plain text.
import { createLowlight } from 'lowlight'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

/** The minimal `hast` shape `lowlight.highlight` returns — typed locally since `@types/hast` is not a direct dependency. */
interface HastText {
  readonly type: 'text'
  readonly value: string
}
interface HastElement {
  readonly type: 'element'
  readonly properties?: Readonly<Record<string, unknown>>
  readonly children: readonly HastNode[]
}
type HastNode = HastText | HastElement
interface HastRoot {
  readonly children: readonly HastNode[]
}

export const MAX_HIGHLIGHT_CHARS = 20_000

export type SyntaxRole = 'keyword' | 'string' | 'comment' | 'constant' | 'function' | 'diff-add' | 'diff-del'

export interface HighlightRun {
  readonly text: string
  readonly role: SyntaxRole | null
}

const lowlight = createLowlight({ bash, css, diff, go, javascript, json, markdown, python, rust, sql, typescript, xml, yaml })
lowlight.registerAlias({ typescript: ['ts', 'tsx'], javascript: ['js', 'jsx'], bash: ['sh', 'shell'], xml: ['html'] })

/** `hast` class names → the renderer's own syntax roles (theme.css tokens). Anything else renders with no role class. */
function roleForClassName(className: string): SyntaxRole | null {
  if (className === 'hljs-keyword' || className === 'hljs-built_in' || className === 'hljs-selector-tag' || className === 'hljs-type') return 'keyword'
  if (className === 'hljs-string' || className === 'hljs-regexp' || className === 'hljs-attr' || className === 'hljs-attribute') return 'string'
  if (className === 'hljs-comment' || className === 'hljs-quote') return 'comment'
  if (className === 'hljs-number' || className === 'hljs-literal' || className === 'hljs-symbol') return 'constant'
  if (className === 'hljs-title' || className.startsWith('hljs-title.') || className === 'hljs-function') return 'function'
  if (className === 'hljs-addition') return 'diff-add'
  if (className === 'hljs-deletion') return 'diff-del'
  return null
}

function roleOf(classNames: readonly unknown[] | undefined): SyntaxRole | null {
  if (classNames === undefined) return null
  for (const raw of classNames) {
    if (typeof raw !== 'string') continue
    const role = roleForClassName(raw)
    if (role !== null) return role
  }
  return null
}

function flatten(nodes: readonly HastNode[], inherited: SyntaxRole | null, out: HighlightRun[]): void {
  for (const node of nodes) {
    if (node.type === 'text') {
      if (node.value !== '') out.push({ text: node.value, role: inherited })
      continue
    }
    if (node.type === 'element') {
      const classNames = Array.isArray(node.properties?.['className']) ? node.properties['className'] : undefined
      const role = roleOf(classNames) ?? inherited
      flatten(node.children, role, out)
    }
  }
}

/** `null` language or one outside the fixed set, or code over `MAX_HIGHLIGHT_CHARS`, returns one plain-text run — never partially highlighted. */
export function highlightTokens(code: string, language: string | null): readonly HighlightRun[] {
  if (language === null || code.length > MAX_HIGHLIGHT_CHARS || !lowlight.registered(language)) return [{ text: code, role: null }]
  let tree: HastRoot
  try {
    tree = lowlight.highlight(language, code) as HastRoot
  } catch {
    return [{ text: code, role: null }]
  }
  const out: HighlightRun[] = []
  flatten(tree.children, null, out)
  return out.length > 0 ? out : [{ text: code, role: null }]
}
