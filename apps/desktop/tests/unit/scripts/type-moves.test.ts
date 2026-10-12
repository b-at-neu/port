import { describe, expect, it } from 'vitest'
import { findDeclarations, findNamedImports, maskNonCode } from '../../../scripts/type-moves.mjs'

describe('maskNonCode', () => {
  it('blanks a line comment, preserving length', () => {
    const src = 'const a = 1 // a brace { here\nconst b = 2'
    const masked = maskNonCode(src)
    expect(masked).toHaveLength(src.length)
    expect(masked).toBe('const a = 1                  \nconst b = 2')
  })

  it('blanks a block comment across lines, preserving newlines', () => {
    const src = 'const a = /* {\n  still a comment } */ 1'
    const masked = maskNonCode(src)
    expect(masked).toHaveLength(src.length)
    expect(masked.split('\n')).toHaveLength(src.split('\n').length)
    expect(masked).not.toContain('{')
    expect(masked).not.toContain('}')
  })

  it('blanks string and template literal contents, including an escaped quote', () => {
    const src = String.raw`const s = 'a { b }'; const t = "a \" } b"`
    const masked = maskNonCode(src)
    expect(masked).toHaveLength(src.length)
    expect(masked).not.toContain('{')
    expect(masked).not.toContain('}')
  })

  it('leaves real code structure untouched', () => {
    const src = 'export interface Foo {\n  bar: string\n}'
    expect(maskNonCode(src)).toBe(src)
  })
})

describe('findDeclarations', () => {
  it('finds an export interface and spans to its matching closing brace', () => {
    const src = "export interface Foo {\n  bar: string\n}\n\nconst x = 1"
    const [decl] = findDeclarations(src)
    expect(decl).toBeDefined()
    expect(decl?.kind).toBe('interface')
    expect(decl?.name).toBe('Foo')
    expect(decl?.text).toBe('export interface Foo {\n  bar: string\n}')
  })

  it('does not let a brace inside a string body break interface depth tracking', () => {
    const src = "export interface Foo {\n  label: '{ not a real brace }'\n}\n"
    const [decl] = findDeclarations(src)
    expect(decl?.text).toBe("export interface Foo {\n  label: '{ not a real brace }'\n}")
  })

  it('finds a single-line export type alias, ending at its semicolon', () => {
    const src = "export type Id = string;\nconst x = 1"
    const [decl] = findDeclarations(src)
    expect(decl?.kind).toBe('type')
    expect(decl?.name).toBe('Id')
    expect(decl?.text).toBe('export type Id = string;')
  })

  it('finds a multi-line union type alias with no trailing semicolon, via the ASI boundary walk', () => {
    const src = "export type Status =\n  | 'open'\n  | 'closed'\n\nconst x = 1"
    const [decl] = findDeclarations(src)
    expect(decl?.kind).toBe('type')
    expect(decl?.name).toBe('Status')
    expect(decl?.text).toBe("export type Status =\n  | 'open'\n  | 'closed'\n")
  })

  it('includes a directly-preceding comment block, but not one separated by a blank line', () => {
    const attached = "// describes Foo\nexport type Foo = string;\n"
    const [declAttached] = findDeclarations(attached)
    expect(declAttached?.text).toBe('// describes Foo\nexport type Foo = string;')

    const detached = "// unrelated\n\nexport type Bar = string;\n"
    const [declDetached] = findDeclarations(detached)
    expect(declDetached?.text).toBe('export type Bar = string;')
  })

  it('ignores a non-exported declaration', () => {
    const src = 'interface Foo {\n  bar: string\n}\n'
    expect(findDeclarations(src)).toHaveLength(0)
  })
})

describe('findNamedImports', () => {
  it('reads names from a named import block', () => {
    const src = "import { Foo, Bar as Baz } from '@/types/foo'"
    const names = findNamedImports(src)
    expect(names).toEqual([
      { name: 'Foo', specifier: '@/types/foo' },
      { name: 'Bar', specifier: '@/types/foo' },
    ])
  })

  it('reads names from an import type block, stripping a per-name type modifier', () => {
    const src = "import { type Foo, Bar } from '@/types/foo'"
    const names = findNamedImports(src)
    expect(names).toEqual([
      { name: 'Foo', specifier: '@/types/foo' },
      { name: 'Bar', specifier: '@/types/foo' },
    ])
  })

  it('reads names from a re-export shim line', () => {
    const src = "export type { Foo } from '@/types/foo'"
    expect(findNamedImports(src)).toEqual([{ name: 'Foo', specifier: '@/types/foo' }])
  })

  it('reads a dynamic import() usage', () => {
    const src = "type X = import('@/types/foo').Foo"
    expect(findNamedImports(src)).toEqual([{ name: 'Foo', specifier: '@/types/foo' }])
  })

  it('reads a dynamic import() indexed-access usage', () => {
    const src = "type X = import('@/types/foo')['Foo']"
    expect(findNamedImports(src)).toEqual([{ name: 'Foo', specifier: '@/types/foo' }])
  })
})
