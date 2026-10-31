// Classifies exported main/ declarations by importer count and rewrites import specifiers per a
// move table once they've been hand-moved into src/types/<topic>.ts.
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const SRC_ROOT = join(DESKTOP_ROOT, 'src')
export const REPO_ROOT = resolve(DESKTOP_ROOT, '..', '..')

const EXTENSIONS = ['.ts', '.tsx', '.mts']

function toPosix(p) {
  return p.split(sep).join('/')
}

export function walkSourceFiles(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...walkSourceFiles(p))
    else if (EXTENSIONS.some((ext) => p.endsWith(ext))) out.push(p)
  }
  return out
}

/** Strips comments and string/template contents to spaces (preserving length) so bracket-depth
 *  scanning never trips on a `;` or brace inside a comment or a string literal. */
export function maskNonCode(src) {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const c2 = src[i + 1]
    if (c === '/' && c2 === '/') {
      let j = i
      while (j < n && src[j] !== '\n') j++
      out += ' '.repeat(j - i)
      i = j
    } else if (c === '/' && c2 === '*') {
      let j = i + 2
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++
      j = Math.min(j + 2, n)
      out += src.slice(i, j).replace(/[^\n]/g, ' ')
      i = j
    } else if (c === '`' || c === "'" || c === '"') {
      const quote = c
      let j = i + 1
      while (j < n && src[j] !== quote) {
        if (src[j] === '\\') j++
        j++
      }
      j = Math.min(j + 1, n)
      out += src.slice(i, j).replace(/[^\n]/g, ' ')
      i = j
    } else {
      out += c
      i++
    }
  }
  return out
}

/** Every top-level `export interface X` / `export type X` declaration, as [{ name, start, end, text }]. */
export function findDeclarations(content) {
  const masked = maskNonCode(content)
  const decls = []
  const re = /^export (interface|type) ([A-Za-z_$][\w$]*)/gm
  let m
  while ((m = re.exec(masked))) {
    const kind = m[1]
    const name = m[2]
    const headerStart = m.index

    let end
    if (kind === 'interface') {
      const braceOpen = masked.indexOf('{', headerStart)
      let depth = 0
      let j = braceOpen
      for (; j < masked.length; j++) {
        if (masked[j] === '{') depth++
        else if (masked[j] === '}') {
          depth--
          if (depth === 0) break
        }
      }
      end = j + 1
    } else {
      // type alias, ASI style: walk line by line, tracking {[( depth, until a line that neither
      // continues a union/arrow/extends nor is followed by one.
      let depth = 0
      let lineStart = headerStart
      end = masked.length
      while (lineStart < masked.length) {
        let lineEnd = masked.indexOf('\n', lineStart)
        if (lineEnd === -1) lineEnd = masked.length
        const line = masked.slice(lineStart, lineEnd)
        let semiAt = -1
        for (let k = 0; k < line.length; k++) {
          const ch = line[k]
          if ('{[('.includes(ch)) depth++
          else if ('}])'.includes(ch)) depth = Math.max(0, depth - 1)
          else if (ch === ';' && depth === 0 && semiAt === -1) semiAt = k
        }
        if (semiAt !== -1) {
          end = lineStart + semiAt + 1
          break
        }
        if (depth === 0) {
          const trimmed = line.trimEnd()
          const continues = /[|&=(,]$/.test(trimmed) || /=>$/.test(trimmed) || /\bextends$/.test(trimmed)
          let nextStart = lineEnd + 1
          while (nextStart < masked.length && masked[nextStart] === '\n') nextStart++
          let nextLineEnd = masked.indexOf('\n', nextStart)
          if (nextLineEnd === -1) nextLineEnd = masked.length
          const nextLine = masked.slice(nextStart, nextLineEnd).trim()
          const nextContinues = /^[|&?:.]/.test(nextLine) || nextLine.startsWith('extends ')
          if (!continues && !nextContinues) {
            end = lineEnd
            break
          }
        }
        lineStart = lineEnd + 1
      }
    }

    // extend start backward over a directly-preceding comment block (no blank line between)
    let start = headerStart
    let lineStart = content.lastIndexOf('\n', start - 1) + 1
    while (lineStart > 0) {
      const prevLineEnd = lineStart - 1
      const prevLineStart = content.lastIndexOf('\n', prevLineEnd - 1) + 1
      const prevLine = content.slice(prevLineStart, prevLineEnd)
      if (/^\s*(\/\*|\*|\/\/)/.test(prevLine) && prevLine.trim() !== '') {
        start = prevLineStart
        lineStart = prevLineStart
      } else break
    }

    decls.push({ name, kind, start, end, text: content.slice(start, end) })
  }
  return decls
}

/** `export type { A, B as C } from '...'` style re-export shim lines. */
function findReexportShims(content) {
  const out = []
  const re = /^export (?:type )?\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/gm
  let m
  while ((m = re.exec(content))) {
    const names = m[1].split(',').map((s) => s.trim()).filter(Boolean)
    out.push({ raw: m[0], names, specifier: m[2], index: m.index })
  }
  return out
}

/** Resolves a module specifier (relative or @/-aliased) from `fromFile` to an absolute source file path, or null. */
function resolveSpecifier(fromFile, spec) {
  let base
  if (spec.startsWith('@/')) base = join(SRC_ROOT, spec.slice(2))
  else if (spec.startsWith('./') || spec.startsWith('../')) base = resolve(dirname(fromFile), spec)
  else return null

  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]
  for (const c of candidates) if (existsSync(c) && statSync(c).isFile()) return c
  return null
}

/** Named imports/re-exports and `import('spec').Name` usages: [{ name, specifier }]. */
export function findNamedImports(content) {
  const out = []
  const blockRe = /\bimport\s+type\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]|\bimport\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]|\bexport\s+type\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]|\bexport\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g
  let m
  while ((m = blockRe.exec(content))) {
    const namesRaw = m[1] ?? m[3] ?? m[5] ?? m[7]
    const spec = m[2] ?? m[4] ?? m[6] ?? m[8]
    for (let part of namesRaw.split(',')) {
      part = part.trim()
      if (!part) continue
      part = part.replace(/^type\s+/, '')
      const name = part.split(/\s+as\s+/)[0].trim()
      if (name) out.push({ name, specifier: spec })
    }
  }
  const dynRe = /\bimport\(\s*['"]([^'"]+)['"]\s*\)\s*\[?\.?\s*(?:\[\s*['"](\w+)['"]\s*\]|(\w+))/g
  while ((m = dynRe.exec(content))) {
    const spec = m[1]
    const name = m[2] ?? m[3]
    if (name) out.push({ name, specifier: spec })
  }
  return out
}

function allSourceFiles() {
  const files = [...walkSourceFiles(SRC_ROOT)]
  const rootScripts = join(REPO_ROOT, 'scripts')
  files.push(...walkSourceFiles(rootScripts))
  files.push(...walkSourceFiles(join(DESKTOP_ROOT, 'tests')))
  return files
}

export const SCAN_ROOTS = ['main', 'renderer']

/** Classification over the scanned roots' non-test files, plus each declaration's importer set. */
export function classify(roots = SCAN_ROOTS) {
  const scanFiles = roots.flatMap((r) => walkSourceFiles(join(SRC_ROOT, r))).filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'))

  const declsByFile = new Map()
  const declByKey = new Map() // `${file}#${name}` -> decl
  for (const file of scanFiles) {
    const content = readFileSync(file, 'utf8')
    const decls = findDeclarations(content)
    if (decls.length) declsByFile.set(file, decls)
    for (const d of decls) declByKey.set(`${file}#${d.name}`, { file, ...d, importers: new Set() })
  }

  // shim resolution: specifier+name -> defining file (for re-export passthroughs)
  const allFiles = allSourceFiles()
  const shimTargets = new Map() // `${shimFile}#${name}` -> definingFile
  for (const file of scanFiles) {
    const content = readFileSync(file, 'utf8')
    for (const shim of findReexportShims(content)) {
      const target = resolveSpecifier(file, shim.specifier)
      if (!target) continue
      for (const n of shim.names) {
        const name = n.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()
        if (declByKey.has(`${target}#${name}`)) shimTargets.set(`${file}#${name}`, target)
      }
    }
  }

  for (const file of allFiles) {
    const content = readFileSync(file, 'utf8')
    for (const imp of findNamedImports(content)) {
      let target = resolveSpecifier(file, imp.specifier)
      if (!target) continue
      let key = `${target}#${imp.name}`
      if (!declByKey.has(key) && shimTargets.has(key)) {
        target = shimTargets.get(key)
        key = `${target}#${imp.name}`
      }
      const decl = declByKey.get(key)
      if (decl && file !== target) decl.importers.add(file)
    }
  }

  return { declByKey, declsByFile, mainFiles: scanFiles }
}

/** Every MULTI-classified declaration under the scanned roots, as [{ type, file, importer }] rows. */
export function findLeakedTypes(files, roots = SCAN_ROOTS) {
  if (files) {
    // in-memory fixture mode: files is [{path, text}], path relative to SRC_ROOT
    const byPath = new Map(files.map((f) => [join(SRC_ROOT, f.path), f.text]))
    const scanFiles = [...byPath.keys()].filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'))
    const declByKey = new Map()
    for (const file of scanFiles) {
      const decls = findDeclarations(byPath.get(file))
      for (const d of decls) declByKey.set(`${file}#${d.name}`, { file, ...d, importers: new Set() })
    }
    for (const file of byPath.keys()) {
      for (const imp of findNamedImports(byPath.get(file))) {
        let target = null
        if (imp.specifier.startsWith('./')) {
          const base = resolve(dirname(file), imp.specifier)
          target = [base, `${base}.ts`, `${base}.tsx`].find((c) => byPath.has(c)) ?? null
        } else if (imp.specifier.startsWith('@/')) {
          const base = join(SRC_ROOT, imp.specifier.slice(2))
          target = [base, `${base}.ts`, `${base}.tsx`].find((c) => byPath.has(c)) ?? null
        }
        if (!target) continue
        const decl = declByKey.get(`${target}#${imp.name}`)
        if (decl && file !== target) decl.importers.add(file)
      }
    }
    const rows = []
    for (const d of declByKey.values()) {
      if (classOf(d, d.file) !== 'MULTI') continue
      rows.push({ type: d.name, file: toPosix(relative(SRC_ROOT, d.file)), importer: toPosix(relative(SRC_ROOT, [...d.importers][0])) })
    }
    return rows
  }

  const { declByKey } = classify(roots)
  const rows = []
  for (const d of declByKey.values()) {
    if (classOf(d, d.file) !== 'MULTI') continue
    rows.push({ type: d.name, file: toPosix(relative(SRC_ROOT, d.file)), importer: toPosix(relative(SRC_ROOT, [...d.importers][0])) })
  }
  return rows
}

// SDK-shaped declarations can't move to types/<topic>.ts: the literal is banned there, and
// types/ can't reach main/ either (web's tsconfig excludes it) — so these stay put.
function namesSdkMessageVariant(decl) {
  return /\bSDK[A-Za-z]+Message\b|\bHostedSdk\b|\bHostedQuery(Fn)?\b|\bAgentInfo\b|\bCanUseTool\b|\bEffortLevel\b|\bModelInfo\b|\bPermissionMode\b|\bPermissionResult\b|\bPermissionUpdate\b|\bSlashCommand\b/.test(decl.text)
}

export function classOf(decl, selfFile) {
  if (namesSdkMessageVariant(decl)) return 'SINGLE-WITH-TEST'
  const importers = [...decl.importers]
  // A declaration's "own test" is either co-located (old layout: foo.ts / foo.test.ts) or mirrored
  // under tests/unit/ (current layout: src/main/x/foo.ts / tests/unit/main/x/foo.test.ts).
  const ext = selfFile.endsWith('.tsx') ? '.tsx' : '.ts'
  const base = selfFile.slice(0, -ext.length)
  const coLocatedTest = `${base}.test${ext}`
  const mirroredTest = selfFile.startsWith(SRC_ROOT) ? join(DESKTOP_ROOT, 'tests', 'unit', `${relative(SRC_ROOT, base)}.test${ext}`) : null
  const ownTests = new Set([coLocatedTest, mirroredTest].filter((p) => p !== null))
  const nonSelfTestImporters = importers.filter((f) => !ownTests.has(f))
  if (nonSelfTestImporters.length === 0 && importers.length === 0) return 'NONE'
  if (nonSelfTestImporters.length === 0) return 'SINGLE-WITH-TEST'
  return 'MULTI'
}

function report() {
  const { declByKey } = classify()
  const rows = [...declByKey.values()].sort((a, b) => (a.file + a.name).localeCompare(b.file + b.name))
  for (const d of rows) {
    const cls = classOf(d, d.file)
    const rel = toPosix(relative(DESKTOP_ROOT, d.file))
    const importerList = [...d.importers].map((f) => toPosix(relative(DESKTOP_ROOT, f))).sort()
    console.log(`${cls}\t${rel}#${d.name}\t${importerList.join(', ')}`)
  }
}

function unexport(dirs, { check }) {
  const { declByKey } = classify()
  const byFile = new Map()
  for (const d of declByKey.values()) {
    if (classOf(d, d.file) !== 'NONE') continue
    if (!byFile.has(d.file)) byFile.set(d.file, [])
    byFile.get(d.file).push(d)
  }

  const targetDirs = dirs.map((d) => resolve(DESKTOP_ROOT, d))
  const changed = []
  for (const [file, decls] of byFile) {
    if (!targetDirs.some((d) => file.startsWith(d))) continue
    let content = readFileSync(file, 'utf8')
    // apply from the end so offsets stay valid
    const sorted = [...decls].sort((a, b) => b.start - a.start)
    let count = 0
    for (const d of sorted) {
      const before = content.slice(0, d.start)
      const decl = content.slice(d.start, d.end)
      const after = content.slice(d.end)
      const newDecl = decl.replace(/^export (interface|type)\b/m, '$1')
      if (newDecl !== decl) {
        content = before + newDecl + after
        count++
      }
    }
    if (count > 0) {
      changed.push(`${toPosix(relative(DESKTOP_ROOT, file))} (${String(count)})`)
      if (!check) writeFileSync(file, content)
    }
  }

  if (check) {
    if (changed.length) {
      for (const l of changed) console.log(l)
      process.exit(1)
    }
    console.log('no changes needed')
    return
  }
  for (const l of changed) console.log(l)
  console.log(`${String(changed.length)} file(s) changed`)
}

function loadTable(path) {
  const raw = JSON.parse(readFileSync(resolve(DESKTOP_ROOT, path), 'utf8'))
  return raw // { "@/main/<file>#<Name>": "@/types/<topic>" }
}

function remap(tablePath, dirs, { check }) {
  const table = loadTable(tablePath)
  // group by old specifier prefix "@/main/<file>" -> { name -> newSpecifier }
  const byOldSpecifier = new Map()
  for (const [key, newSpec] of Object.entries(table)) {
    const hashIdx = key.lastIndexOf('#')
    const oldSpec = key.slice(0, hashIdx)
    const name = key.slice(hashIdx + 1)
    if (!byOldSpecifier.has(oldSpec)) byOldSpecifier.set(oldSpec, new Map())
    byOldSpecifier.get(oldSpec).set(name, newSpec)
  }

  const targetDirs = dirs.map((d) => resolve(DESKTOP_ROOT, d))
  const files = targetDirs.flatMap((d) => walkSourceFiles(d))
  const changed = []

  const importLineRe = /^(import\s+type\s*\{)([^}]*)(\}\s*from\s*)(['"])([^'"]+)\4(;?)$/gm
  const importLineRe2 = /^(import\s*\{)([^}]*)(\}\s*from\s*)(['"])([^'"]+)\4(;?)$/gm

  for (const file of files) {
    let content = readFileSync(file, 'utf8')
    let count = 0

    for (const re of [importLineRe, importLineRe2]) {
      re.lastIndex = 0
      content = content.replace(re, (whole, head, names, mid, quote, spec, semi) => {
        const nameMap = byOldSpecifier.get(spec)
        if (!nameMap) return whole
        const parts = names.split(',').map((s) => s.trim()).filter(Boolean)
        const keep = []
        const moved = new Map() // newSpec -> [part,...]
        let any = false
        for (const part of parts) {
          const bare = part.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()
          if (nameMap.has(bare)) {
            any = true
            const ns = nameMap.get(bare)
            if (!moved.has(ns)) moved.set(ns, [])
            moved.get(ns).push(part)
          } else {
            keep.push(part)
          }
        }
        if (!any) return whole
        count++
        // A fresh import line, even if the file already imports from the new specifier elsewhere —
        // a duplicate import is valid TS, and merging in place risks dropping the move.
        const lines = []
        if (keep.length) lines.push(`${head} ${keep.join(', ')} ${mid}${quote}${spec}${quote}${semi}`)
        for (const [ns, nparts] of moved) {
          lines.push(`${head} ${nparts.join(', ')} ${mid}${quote}${ns}${quote}${semi}`)
        }
        return lines.join('\n')
      })
    }

    const original = readFileSync(file, 'utf8')
    if (content !== original) {
      changed.push(`${toPosix(relative(DESKTOP_ROOT, file))} (${String(count)})`)
      if (!check) writeFileSync(file, content)
    }
  }

  if (check) {
    if (changed.length) {
      for (const l of changed) console.log(l)
      process.exit(1)
    }
    console.log('no changes needed')
    return
  }
  for (const l of changed) console.log(l)
  console.log(`${String(changed.length)} file(s) changed`)
}

function parseArgs(argv) {
  const mode = argv[0]
  const check = argv.includes('--check')
  const rest = argv.slice(1).filter((a) => a !== '--check')
  return { mode, check, rest }
}

function main() {
  const { mode, check, rest } = parseArgs(process.argv.slice(2))
  if (mode === '--unexport') return unexport(rest.length ? rest : ['src'], { check })
  if (mode === '--remap') return remap(rest[0], rest.slice(1).length ? rest.slice(1) : ['src'], { check })
  if (mode === '--check') return report() // report has no write mode, --check alone just reports
  return report()
}

if (import.meta.url === `file://${process.argv[1]}`) main()
