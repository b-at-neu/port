// No imports, same layout as no-raw-colour.mjs, so a check can dynamically import this with no node_modules.
// Flags a `../` specifier that resolves into `src/`, via a lexical join — no filesystem read.

const MESSAGE = 'Relative parent import — use the @/ alias (@/main/…, @/renderer/…, @/types/…, @/utils/…).'

/** Lexically resolves `spec` against `file`'s directory — a plain string join, not `path.resolve`. */
function resolveSpecifier(file, spec) {
  const segs = file.split('\\').join('/').split('/')
  segs.pop() // drop the file's own basename, leaving its directory
  for (const part of spec.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') segs.pop()
    else segs.push(part)
  }
  return segs.join('/')
}

/** True when `spec`, written from `file` (under `src/` or `tests/`), resolves into `src/`. */
export function isParentImport(file, spec) {
  if (!spec.startsWith('../')) return false
  const normalized = file.split('\\').join('/')
  if (!normalized.includes('/src/') && !normalized.includes('/tests/')) return false
  return resolveSpecifier(normalized, spec).includes('/src/')
}

export const CASES = [
  { file: '/repo/apps/desktop/src/shared/hosting/types.ts', spec: '../repos', flagged: true },
  { file: '/repo/apps/desktop/src/renderer/local/inspect.ts', spec: './shape', flagged: false },
  { file: '/repo/apps/desktop/src/shared/ipc.ts', spec: '@/repos', flagged: false },
  { file: '/repo/apps/desktop/src/shared/labels/defaults.ts', spec: '../../../../../plugins/port/data/labels.json', flagged: false },
  { file: '/repo/apps/desktop/tests/unit/main/hosting/store.test.ts', spec: '../../../../src/main/hosting/store', flagged: true },
  { file: '/repo/apps/desktop/tests/unit/main/hosting/store.test.ts', spec: '../../fixtures/store-fixture', flagged: false },
  { file: '/repo/apps/desktop/tests/unit/main/hosting/store.test.ts', spec: './helpers', flagged: false },
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
