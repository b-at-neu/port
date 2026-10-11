// No imports, same layout as no-raw-colour.mjs, so a check can dynamically import this with no node_modules.
// Flags a `../` specifier whose target is still inside `src`, worked out with string arithmetic, not a filesystem read.

const MESSAGE = 'Relative parent import — use the @/ alias (@/main/…, @/renderer/…, @/types/…, @/utils/…).'

/** How many `../` segments a specifier opens with. */
function leadingParentCount(spec) {
  let count = 0
  let rest = spec
  while (rest.startsWith('../')) {
    count++
    rest = rest.slice(3)
  }
  return count
}

/** How many path segments `file` sits below its nearest `src/` ancestor —
 *  `null` when `file` carries no `/src/` segment at all (outside the app). */
function depthUnderSrc(file) {
  const normalized = file.split('\\').join('/')
  const marker = '/src/'
  const idx = normalized.lastIndexOf(marker)
  if (idx === -1) return null
  const rel = normalized.slice(idx + marker.length)
  // The file itself does not count as a directory level.
  return rel.split('/').length - 1
}

/** True when `spec`, written from `file`, is a `../` import whose target still lands inside `src`. */
export function isParentImport(file, spec) {
  if (!spec.startsWith('../')) return false
  const depth = depthUnderSrc(file)
  if (depth === null) return false
  const climbs = leadingParentCount(spec)
  return climbs <= depth
}

export const CASES = [
  { file: '/repo/apps/desktop/src/types/hosting.ts', spec: '../utils/repos', flagged: true },
  { file: '/repo/apps/desktop/src/renderer/local/inspect.ts', spec: './shape', flagged: false },
  { file: '/repo/apps/desktop/src/types/ipc.ts', spec: '@/utils/repos', flagged: false },
  { file: '/repo/apps/desktop/src/utils/labels/defaults.ts', spec: '../../../../../plugins/port/data/labels.json', flagged: false },
]

function checkSpecifier(context, node, spec) {
  if (isParentImport(context.filename, spec)) context.report({ node, messageId: 'parent-import' })
}

export const rule = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Disallows a relative parent import that stays inside src/ — use the @/ alias instead.' },
    schema: [],
    messages: { 'parent-import': MESSAGE },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        checkSpecifier(context, node, node.source.value)
      },
      ExportNamedDeclaration(node) {
        if (node.source) checkSpecifier(context, node, node.source.value)
      },
      ExportAllDeclaration(node) {
        checkSpecifier(context, node, node.source.value)
      },
      ImportExpression(node) {
        if (node.source.type === 'Literal' && typeof node.source.value === 'string') checkSpecifier(context, node, node.source.value)
      },
      CallExpression(node) {
        const callee = node.callee
        const isViMock =
          callee.type === 'MemberExpression' &&
          callee.object.type === 'Identifier' &&
          callee.object.name === 'vi' &&
          callee.property.type === 'Identifier' &&
          (callee.property.name === 'mock' || callee.property.name === 'importActual')
        if (!isViMock) return
        const arg = node.arguments[0]
        if (arg && arg.type === 'Literal' && typeof arg.value === 'string') checkSpecifier(context, node, arg.value)
      },
    }
  },
}
