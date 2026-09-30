import { describe, expect, it } from 'vitest'
import { createPathOps } from './paths'
import type { PathFlavour, PathOps } from './paths'

interface Case {
  readonly name: string
  readonly posix: readonly [string, string]
  readonly win32: readonly [string, string]
}

const flavours: readonly PathFlavour[] = ['posix', 'win32']

function opsFor(flavour: PathFlavour, home: string): PathOps {
  return createPathOps(flavour, { home })
}

describe('toNative / toPosix round trip', () => {
  for (const flavour of flavours) {
    const ops = opsFor(flavour, flavour === 'win32' ? 'C:\\Users\\u' : '/home/u')
    const input = flavour === 'win32' ? 'C:/Users/u/repo' : '/home/u/repo'

    it(`toPosix(toNative(p)) === toPosix(p) [${flavour}]`, () => {
      expect(ops.toPosix(ops.toNative(input))).toBe(ops.toPosix(input))
    })

    it(`toNative converts to the flavour's separator [${flavour}]`, () => {
      const native = ops.toNative(input)
      if (flavour === 'win32') {
        expect(native).toBe('C:\\Users\\u\\repo')
      } else {
        expect(native).toBe('/home/u/repo')
      }
    })

    it(`throws TypeError on an empty input [${flavour}]`, () => {
      expect(() => ops.toNative('')).toThrow(TypeError)
      expect(() => ops.toPosix('')).toThrow(TypeError)
    })

    it(`throws TypeError on a relative input [${flavour}]`, () => {
      const relative = flavour === 'win32' ? 'Users\\u\\repo' : 'home/u/repo'
      expect(() => ops.toNative(relative)).toThrow(TypeError)
      expect(() => ops.pathKey(relative)).toThrow(TypeError)
    })
  }
})

describe('pathKey / samePath', () => {
  it('trailing separator does not change identity [posix]', () => {
    const ops = opsFor('posix', '/home/u')
    expect(ops.samePath('/a/b/', '/a/b')).toBe(true)
  })

  it('trailing separator does not change identity [win32]', () => {
    const ops = opsFor('win32', 'C:\\Users\\u')
    expect(ops.samePath('C:\\a\\b\\', 'C:\\a\\b')).toBe(true)
  })

  it('. and .. segments normalize to the same identity [posix]', () => {
    const ops = opsFor('posix', '/home/u')
    expect(ops.samePath('/a/./b/../b/c', '/a/b/c')).toBe(true)
  })

  it('drive-letter case and separator mix are equal on win32', () => {
    const ops = opsFor('win32', 'C:\\Users\\u')
    expect(ops.samePath('C:\\Users\\u\\repo', 'c:/users/U/Repo')).toBe(true)
  })

  it('case differences are not folded on posix (fails toward the visible duplicate)', () => {
    const ops = opsFor('posix', '/home/u')
    expect(ops.samePath('/Users/u/Repo', '/users/U/repo')).toBe(false)
  })

  it('different drives are unequal on win32', () => {
    const ops = opsFor('win32', 'C:\\Users\\u')
    expect(ops.samePath('C:\\repo', 'D:\\repo')).toBe(false)
  })

  it('a UNC path keys consistently on win32', () => {
    const ops = opsFor('win32', 'C:\\Users\\u')
    expect(ops.samePath('\\\\server\\share\\repo', '\\\\SERVER\\share\\Repo')).toBe(true)
  })

  it('toNative preserves a UNC path\'s leading double separator [win32]', () => {
    const ops = opsFor('win32', 'C:\\Users\\u')
    expect(ops.toNative('\\\\server\\share\\repo')).toBe('\\\\server\\share\\repo')
    expect(ops.toNative('//server/share/repo')).toBe('\\\\server\\share\\repo')
  })
})

describe('contains', () => {
  it('is false for a sibling with a shared prefix [posix]', () => {
    const ops = opsFor('posix', '/home/u')
    expect(ops.contains('/a/b', '/a/bc')).toBe(false)
  })

  it('is true for a genuine child [posix]', () => {
    const ops = opsFor('posix', '/home/u')
    expect(ops.contains('/a/b', '/a/b/c')).toBe(true)
  })

  it('is strict — a path does not contain itself [posix]', () => {
    const ops = opsFor('posix', '/home/u')
    expect(ops.contains('/a/b', '/a/b')).toBe(false)
  })

  it('is false for a sibling with a shared prefix [win32]', () => {
    const ops = opsFor('win32', 'C:\\Users\\u')
    expect(ops.contains('C:\\a\\b', 'C:\\a\\bc')).toBe(false)
  })

  it('is true for a genuine child [win32]', () => {
    const ops = opsFor('win32', 'C:\\Users\\u')
    expect(ops.contains('C:\\a\\b', 'C:\\a\\b\\c')).toBe(true)
  })
})

describe('expandHome', () => {
  it('expands a bare ~ [posix]', () => {
    const ops = opsFor('posix', '/home/u')
    expect(ops.expandHome('~')).toBe('/home/u')
  })

  it('expands ~/x [posix]', () => {
    const ops = opsFor('posix', '/home/u')
    expect(ops.expandHome('~/x')).toBe('/home/u/x')
  })

  it('does not expand ~x [posix]', () => {
    const ops = opsFor('posix', '/home/u')
    expect(ops.expandHome('~x')).toBe('~x')
  })

  it('expands ~\\x [win32]', () => {
    const ops = opsFor('win32', 'C:\\Users\\u')
    expect(ops.expandHome('~\\x')).toBe('C:\\Users\\u\\x')
  })
})

describe('resolveFrom', () => {
  it('resolves a relative path against an absolute base [posix]', () => {
    const ops = opsFor('posix', '/home/u')
    expect(ops.resolveFrom('/a/b', '../c')).toBe('/a/c')
  })

  it('throws TypeError on a relative base [posix]', () => {
    const ops = opsFor('posix', '/home/u')
    expect(() => ops.resolveFrom('a/b', 'c')).toThrow(TypeError)
  })
})

describe('join', () => {
  it('joins segments onto an absolute base [posix]', () => {
    const ops = opsFor('posix', '/home/u')
    expect(ops.join('/a/b', 'c', 'd.json')).toBe('/a/b/c/d.json')
  })

  it('joins segments onto an absolute base [win32]', () => {
    const ops = opsFor('win32', 'C:\\Users\\u')
    expect(ops.join('C:\\a\\b', 'c', 'd.json')).toBe('C:\\a\\b\\c\\d.json')
  })

  it('throws TypeError on a relative base [posix]', () => {
    const ops = opsFor('posix', '/home/u')
    expect(() => ops.join('a/b', 'c')).toThrow(TypeError)
  })

  it('throws TypeError on a relative base [win32]', () => {
    const ops = opsFor('win32', 'C:\\Users\\u')
    expect(() => ops.join('a\\b', 'c')).toThrow(TypeError)
  })
})

describe('dirname', () => {
  it('returns the parent directory [posix]', () => {
    const ops = opsFor('posix', '/home/u')
    expect(ops.dirname('/a/b/c.json')).toBe('/a/b')
  })

  it('returns the parent directory [win32]', () => {
    const ops = opsFor('win32', 'C:\\Users\\u')
    expect(ops.dirname('C:\\a\\b\\c.json')).toBe('C:\\a\\b')
  })

  it('throws TypeError on a relative input [posix]', () => {
    const ops = opsFor('posix', '/home/u')
    expect(() => ops.dirname('a/b')).toThrow(TypeError)
  })

  it('throws TypeError on a relative input [win32]', () => {
    const ops = opsFor('win32', 'C:\\Users\\u')
    expect(() => ops.dirname('a\\b')).toThrow(TypeError)
  })
})

describe('basename', () => {
  it('returns the final segment [posix]', () => {
    const ops = opsFor('posix', '/home/u')
    expect(ops.basename('/repo/.claude/worktrees/impl-77')).toBe('impl-77')
  })

  it('returns the final segment [win32]', () => {
    const ops = opsFor('win32', 'C:\\Users\\u')
    expect(ops.basename('C:\\repo\\.claude\\worktrees\\impl-77')).toBe('impl-77')
  })

  it('ignores a trailing separator [posix]', () => {
    const ops = opsFor('posix', '/home/u')
    expect(ops.basename('/repo/agent-deadbeef/')).toBe('agent-deadbeef')
  })

  it('ignores a trailing separator [win32]', () => {
    const ops = opsFor('win32', 'C:\\Users\\u')
    expect(ops.basename('C:\\repo\\agent-deadbeef\\')).toBe('agent-deadbeef')
  })

  it('returns the root itself for a bare root [posix]', () => {
    const ops = opsFor('posix', '/home/u')
    expect(ops.basename('/')).toBe('')
  })

  it('returns the drive root itself for a bare root [win32]', () => {
    const ops = opsFor('win32', 'C:\\Users\\u')
    expect(ops.basename('C:\\')).toBe('')
  })

  it('throws TypeError on a relative input [posix]', () => {
    const ops = opsFor('posix', '/home/u')
    expect(() => ops.basename('a/b')).toThrow(TypeError)
  })

  it('throws TypeError on a relative input [win32]', () => {
    const ops = opsFor('win32', 'C:\\Users\\u')
    expect(() => ops.basename('a\\b')).toThrow(TypeError)
  })
})

// The acceptance case table: every row below runs under both flavours, so
// the Windows cases execute on Linux and the POSIX cases on Windows.
const table: readonly Case[] = [
  { name: 'nested child is contained', posix: ['/a/b', '/a/b/c'], win32: ['C:\\a\\b', 'C:\\a\\b\\c'] },
]

describe('cross-flavour case table', () => {
  for (const row of table) {
    for (const flavour of flavours) {
      const [parent, child] = flavour === 'posix' ? row.posix : row.win32
      const home = flavour === 'win32' ? 'C:\\Users\\u' : '/home/u'
      it(`${row.name} [${flavour}]`, () => {
        const ops = opsFor(flavour, home)
        expect(ops.contains(parent, child)).toBe(true)
      })
    }
  }
})
