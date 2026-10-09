import { describe, expect, it } from 'vitest'
import { parseUnifiedDiff } from './diff'

describe('parseUnifiedDiff', () => {
  it('parses a simple modification into one file with context, add, and del lines', () => {
    const stdout = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index e69de29..4b825dc 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,3 @@',
      ' context',
      '-removed',
      '+added',
      ' trailing',
      '',
    ].join('\n')
    const result = parseUnifiedDiff(stdout)
    expect(result.files).toHaveLength(1)
    const file = result.files[0]
    expect(file?.path).toBe('src/a.ts')
    expect(file?.isNewFile).toBe(false)
    expect(file?.additions).toBe(1)
    expect(file?.deletions).toBe(1)
    expect(file?.hunks).toHaveLength(1)
    expect(file?.hunks[0]?.lines.map((line) => line.text)).toEqual([' context', '-removed', '+added', ' trailing'])
    expect(file?.hunks[0]?.lines.map((line) => line.sign)).toEqual(['context', 'del', 'add', 'context'])
  })

  it('marks a new file as isNewFile with the old side at /dev/null', () => {
    const stdout = ['diff --git a/src/b.ts b/src/b.ts', 'new file mode 100644', 'index 0000000..e69de29', '--- /dev/null', '+++ b/src/b.ts', '@@ -0,0 +1,2 @@', '+one', '+two', ''].join('\n')
    const result = parseUnifiedDiff(stdout)
    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.isNewFile).toBe(true)
    expect(result.files[0]?.additions).toBe(2)
    expect(result.files[0]?.deletions).toBe(0)
  })

  it('reports a deleted file at its old path, never isNewFile', () => {
    const stdout = ['diff --git a/src/c.ts b/src/c.ts', 'deleted file mode 100644', 'index e69de29..0000000', '--- a/src/c.ts', '+++ /dev/null', '@@ -1,1 +0,0 @@', '-gone', ''].join('\n')
    const result = parseUnifiedDiff(stdout)
    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.path).toBe('src/c.ts')
    expect(result.files[0]?.isNewFile).toBe(false)
    expect(result.files[0]?.deletions).toBe(1)
  })

  it('collects a binary file into `binary`, never into `files`', () => {
    const stdout = ['diff --git a/img.png b/img.png', 'index aaa..bbb 100644', 'Binary files a/img.png and b/img.png differ', ''].join('\n')
    const result = parseUnifiedDiff(stdout)
    expect(result.files).toHaveLength(0)
    expect(result.binary).toEqual(['img.png'])
  })

  it('drops a trailing "\\ No newline at end of file" marker without adding a line for it', () => {
    const stdout = ['diff --git a/d.ts b/d.ts', 'index aaa..bbb 100644', '--- a/d.ts', '+++ b/d.ts', '@@ -1 +1 @@', '-old', '\\ No newline at end of file', '+new', '\\ No newline at end of file', ''].join(
      '\n',
    )
    const result = parseUnifiedDiff(stdout)
    expect(result.files[0]?.hunks[0]?.lines).toHaveLength(2)
    expect(result.files[0]?.hunks[0]?.lines.map((line) => line.text)).toEqual(['-old', '+new'])
  })

  it('strips a trailing \\r without splitting the line (CRLF source)', () => {
    const stdout = ['diff --git a/e.ts b/e.ts', 'index aaa..bbb 100644', '--- a/e.ts', '+++ b/e.ts', '@@ -1 +1 @@', '+added\r', ''].join('\n')
    const result = parseUnifiedDiff(stdout)
    expect(result.files[0]?.hunks[0]?.lines).toEqual([{ sign: 'add', text: '+added' }])
  })

  it('parses multiple files from one diff', () => {
    const stdout = [
      'diff --git a/a.ts b/a.ts',
      'index aaa..bbb 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '+x',
      'diff --git a/b.ts b/b.ts',
      'index ccc..ddd 100644',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1 +1 @@',
      '+y',
      '',
    ].join('\n')
    const result = parseUnifiedDiff(stdout)
    expect(result.files.map((file) => file.path)).toEqual(['a.ts', 'b.ts'])
  })

  it('returns no files for empty stdout', () => {
    expect(parseUnifiedDiff('')).toEqual({ files: [], binary: [] })
  })
})
