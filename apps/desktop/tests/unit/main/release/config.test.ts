import { describe, expect, it } from 'vitest'
import type { RefRead } from '@/types/registry'
import { readReleaseConfig } from '@/main/release/config'

function reader(read: RefRead) {
  return () => Promise.resolve(read)
}

function file(value: unknown): RefRead {
  return { ok: true, text: JSON.stringify(value) }
}

describe('readReleaseConfig', () => {
  it('resolves the schema defaults when there is no release block', async () => {
    const read = await readReleaseConfig(reader(file({ repo: 'acme/widgets' })))
    expect(read).toEqual({ ok: true, config: { versionSource: 'tags', versionFiles: [], versionCommand: null, postPublishHook: null } })
  })

  it('reads every release field it is given', async () => {
    const release = { versionSource: 'package', versionFiles: ['package.json', 'apps/desktop/package.json'], versionCommand: null, postPublishHook: 'node scripts/dev-window.ts' }
    const read = await readReleaseConfig(reader(file({ repo: 'acme/widgets', release })))
    expect(read).toEqual({ ok: true, config: release })
  })

  it('falls back to the default for a violated path only', async () => {
    const read = await readReleaseConfig(reader(file({ repo: 'acme/widgets', release: { versionSource: 'svn', versionFiles: ['package.json'] } })))
    expect(read).toEqual({ ok: true, config: { versionSource: 'tags', versionFiles: ['package.json'], versionCommand: null, postPublishHook: null } })
  })

  it('falls back to every default when the release block is not an object', async () => {
    const read = await readReleaseConfig(reader(file({ repo: 'acme/widgets', release: 'oops' })))
    expect(read).toMatchObject({ ok: true, config: { versionSource: 'tags', versionFiles: [] } })
  })

  it('fails the read rather than guessing when the file is unreadable or malformed', async () => {
    expect(await readReleaseConfig(reader({ ok: false, kind: 'unreadable', message: 'disk on fire' }))).toEqual({ ok: false, message: "Couldn't read .claude/port.config.json: disk on fire" })
    const malformed = await readReleaseConfig(reader({ ok: true, text: '{nope' }))
    expect(malformed.ok).toBe(false)
  })
})
