import { describe, expect, it } from 'vitest'
import { gitRepoRoot, parsePorcelainStanzas, splitNul } from './git'
import { pathOps } from './paths'

// A captured `git worktree list --porcelain` fixture covering the main
// checkout, a linked worktree, `detached`, `bare`, and `locked <reason>`.
const PORCELAIN_FIXTURE = [
  'worktree /home/u/repo',
  'HEAD abc123def456',
  'branch refs/heads/main',
  '',
  'worktree /home/u/repo-feature',
  'HEAD 789fed321',
  'detached',
  '',
  'worktree /home/u/repo-bare.git',
  'HEAD 000111222',
  'bare',
  '',
  'worktree /home/u/repo-locked',
  'HEAD 333444555',
  'branch refs/heads/wip',
  'locked a manual reason with spaces',
  '',
].join('\n')

describe('parsePorcelainStanzas', () => {
  it('parses each stanza into its own map', () => {
    const stanzas = parsePorcelainStanzas(PORCELAIN_FIXTURE)
    expect(stanzas).toHaveLength(4)
  })

  it('parses a plain worktree with a branch', () => {
    const [main] = parsePorcelainStanzas(PORCELAIN_FIXTURE)
    expect(main?.get('worktree')).toBe('/home/u/repo')
    expect(main?.get('HEAD')).toBe('abc123def456')
    expect(main?.get('branch')).toBe('refs/heads/main')
  })

  it('parses a boolean-only key (detached) as true', () => {
    const stanzas = parsePorcelainStanzas(PORCELAIN_FIXTURE)
    expect(stanzas[1]?.get('detached')).toBe(true)
  })

  it('parses bare as true', () => {
    const stanzas = parsePorcelainStanzas(PORCELAIN_FIXTURE)
    expect(stanzas[2]?.get('bare')).toBe(true)
  })

  it('parses locked <reason>, keeping the reason as the value', () => {
    const stanzas = parsePorcelainStanzas(PORCELAIN_FIXTURE)
    expect(stanzas[3]?.get('locked')).toBe('a manual reason with spaces')
  })

  it('handles CRLF line endings identically to LF', () => {
    const crlf = PORCELAIN_FIXTURE.split('\n').join('\r\n')
    expect(parsePorcelainStanzas(crlf)).toEqual(parsePorcelainStanzas(PORCELAIN_FIXTURE))
  })

  it('returns an empty array for empty stdout', () => {
    expect(parsePorcelainStanzas('')).toEqual([])
  })
})

describe('splitNul', () => {
  it('splits on NUL and drops the trailing separator', () => {
    expect(splitNul('a\0b\0c\0')).toEqual(['a', 'b', 'c'])
  })

  it('preserves a newline inside a path', () => {
    expect(splitNul('a\nb\0c\0')).toEqual(['a\nb', 'c'])
  })

  it('returns an empty array for empty stdout', () => {
    expect(splitNul('')).toEqual([])
  })
})

describe('gitRepoRoot — integration', () => {
  it('resolves this checkout when git is available', async (ctx) => {
    const result = await gitRepoRoot(process.cwd())
    if (!result.ok) {
      if (result.kind === 'not-found') {
        ctx.skip()
        return
      }
      throw new Error(`unexpected failure: ${JSON.stringify(result)}`)
    }
    const cwd = process.cwd()
    expect(pathOps.samePath(result.root, cwd) || pathOps.contains(result.root, cwd)).toBe(true)
  })

  it('reports not-a-repository outside a git checkout', async (ctx) => {
    const result = await gitRepoRoot(pathOps.flavour === 'win32' ? 'C:\\' : '/')
    if (!result.ok && result.kind === 'not-found') {
      ctx.skip()
      return
    }
    expect(result).toEqual({ ok: false, kind: 'not-a-repository' })
  })
})
