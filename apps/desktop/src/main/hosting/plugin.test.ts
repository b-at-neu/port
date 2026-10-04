import { describe, expect, it } from 'vitest'
import { readExpectedComponents, resolvePluginRequest } from './plugin'
import type { ReadExpectedComponentsDeps, ResolvePluginRequestDeps } from './plugin'
import { pathOps } from '../platform'
import type { DirEntry, FileResult } from '../platform'

function jsonDeps(result: FileResult<unknown>): ResolvePluginRequestDeps {
  return { readJsonFile: () => Promise.resolve(result as never), join: (base, ...segments) => pathOps.join(base, ...segments) }
}

describe('resolvePluginRequest', () => {
  it('resolves installed when the manifest is not found', async () => {
    const request = await resolvePluginRequest('/repo', jsonDeps({ ok: false, kind: 'not-found', message: 'nope' }))
    expect(request).toEqual({ source: 'installed' })
  })

  it('resolves installed when the manifest names a different plugin', async () => {
    const request = await resolvePluginRequest('/repo', jsonDeps({ ok: true, value: { name: 'other' } }))
    expect(request).toEqual({ source: 'installed' })
  })

  it('resolves repository when the manifest names port', async () => {
    const request = await resolvePluginRequest('/repo', jsonDeps({ ok: true, value: { name: 'port' } }))
    expect(request).toEqual({ source: 'repository', path: pathOps.join('/repo', 'plugins', 'port') })
  })

  it('resolves repository, not installed, when the manifest exists but cannot be read — fails loud rather than silently falling back', async () => {
    const request = await resolvePluginRequest('/repo', jsonDeps({ ok: false, kind: 'permission-denied', message: 'nope' }))
    expect(request).toEqual({ source: 'repository', path: pathOps.join('/repo', 'plugins', 'port') })
  })

  it('resolves repository when the manifest is unparseable', async () => {
    const request = await resolvePluginRequest('/repo', jsonDeps({ ok: false, kind: 'unparseable', message: 'bad json' }))
    expect(request).toEqual({ source: 'repository', path: pathOps.join('/repo', 'plugins', 'port') })
  })
})

function dirDeps(skills: FileResult<readonly DirEntry[]>, agents: FileResult<readonly DirEntry[]>): ReadExpectedComponentsDeps {
  return {
    join: (base, ...segments) => pathOps.join(base, ...segments),
    listDirectory: (path: string) => Promise.resolve(path.endsWith('skills') ? skills : agents),
  }
}

describe('readExpectedComponents', () => {
  it('returns skill directory names and agent basenames with .md stripped', async () => {
    const skills: FileResult<readonly DirEntry[]> = { ok: true, value: [{ name: 'pipeline', kind: 'directory' }, { name: 'scope', kind: 'directory' }, { name: 'README.md', kind: 'file' }] }
    const agents: FileResult<readonly DirEntry[]> = { ok: true, value: [{ name: 'plan-agent.md', kind: 'file' }, { name: 'impl-agent.md', kind: 'file' }] }
    const result = await readExpectedComponents('/repo/plugins/port', dirDeps(skills, agents))
    expect(result).toEqual({ skills: ['pipeline', 'scope'], agents: ['plan-agent', 'impl-agent'] })
  })

  it('returns null when either read fails — never treated as complete', async () => {
    const skills: FileResult<readonly DirEntry[]> = { ok: false, kind: 'not-found', message: 'nope' }
    const agents: FileResult<readonly DirEntry[]> = { ok: true, value: [] }
    const result = await readExpectedComponents('/repo/plugins/port', dirDeps(skills, agents))
    expect(result).toBeNull()
  })
})
