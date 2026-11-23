// Rewrites a relative import inside apps/desktop/src into its @/ equivalent.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { posix as posixPath } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const SRC_ROOT = join(DESKTOP_ROOT, 'src')

const EXTENSIONS = ['.ts', '.tsx', '.mts']

/** Every file under `dir` (absolute) with one of EXTENSIONS, recursively. */
export function walkSourceFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...walkSourceFiles(p))
    else if (EXTENSIONS.some((ext) => p.endsWith(ext))) out.push(p)
  }
  return out
}

/** `path` with every separator normalized to `/`. */
function toPosix(path) {
  return path.split(sep).join('/')
}

/** Resolves a relative `spec` (as text, never against the filesystem) against `fromFile`'s own directory.
 *  A target inside `srcRoot` becomes `@/` plus its posix path relative to it; a target outside is left alone. */
export function rewriteSpecifier(fromFile, spec, srcRoot) {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return spec

  const fileDirFromSrc = toPosix(relative(srcRoot, dirname(fromFile)))
  const targetFromSrc = posixPath.normalize(posixPath.join(fileDirFromSrc, spec))

  if (targetFromSrc === '..' || targetFromSrc.startsWith('../')) return spec
  return `@/${targetFromSrc}`
}

function applyPattern(content, pattern, specIndex, quoteIndex, rewrite, counter) {
  return content.replace(pattern, (whole, ...rest) => {
    const groups = rest.slice(0, -2) // drop offset and full string, keep only the capture groups
    const quote = groups[quoteIndex]
    const spec = groups[specIndex]
    const newSpec = rewrite(spec)
    if (newSpec === spec) return whole
    counter.count++
    return whole.replace(`${quote}${spec}${quote}`, `${quote}${newSpec}${quote}`)
  })
}

/** Rewrites every specifier in `content` via `rewrite(spec) => newSpec`. Returns `{ content, count }`. */
function rewriteFileContent(content, rewrite) {
  const counter = { count: 0 }
  let next = content
  // from '<spec>' — groups: (ws)(quote)(spec)
  next = applyPattern(next, /\bfrom(\s+)(['"])([^'"]+)\2/g, 2, 1, rewrite, counter)
  // import '<spec>' — groups: (ws)(quote)(spec)
  next = applyPattern(next, /\bimport(\s+)(['"])([^'"]+)\2/g, 2, 1, rewrite, counter)
  // import('<spec>') — groups: (paren)(quote)(spec)
  next = applyPattern(next, /\bimport(\()(['"])([^'"]+)\2/g, 2, 1, rewrite, counter)
  // vi.mock('<spec>' / vi.importActual('<spec>' — groups: (callee)(paren)(quote)(spec)
  next = applyPattern(next, /\b(vi\.mock|vi\.importActual)(\()(['"])([^'"]+)\3/g, 3, 2, rewrite, counter)
  return { content: next, count: counter.count }
}

/** Rewrites one file in place (or just reports, when `write` is false).
 *  Returns the number of specifiers changed. */
function processFile(file, { write }) {
  const original = readFileSync(file, 'utf8')
  const { content, count } = rewriteFileContent(original, (spec) => rewriteSpecifier(file, spec, SRC_ROOT))
  if (count > 0 && write) writeFileSync(file, content)
  return count
}

function main() {
  const argv = process.argv.slice(2)
  const check = argv.includes('--check')
  const dirs = argv.filter((a) => a !== '--check')
  if (dirs.length === 0) {
    console.error('usage: node scripts/alias-imports.mjs [--check] <dir>...')
    process.exit(2)
  }

  const changed = []
  let total = 0
  for (const dir of dirs) {
    const absDir = resolve(DESKTOP_ROOT, dir)
    for (const file of walkSourceFiles(absDir)) {
      const count = processFile(file, { write: !check })
      if (count > 0) {
        changed.push(`${toPosix(relative(DESKTOP_ROOT, file))} (${String(count)})`)
        total += count
      }
    }
  }

  if (check) {
    if (changed.length > 0) {
      for (const line of changed) console.log(line)
      console.log(`${String(changed.length)} file(s) would change, ${String(total)} specifier(s) total`)
      process.exit(1)
    }
    console.log('no changes needed')
    return
  }

  for (const line of changed) console.log(line)
  console.log(`${String(changed.length)} file(s) changed, ${String(total)} specifier(s) total`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
