import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createPlatform } from '@/main/platform'
import { githubConditional, githubHttp, githubPublic } from '@/main/platform/github-http'
import { createJsonStore } from '@/main/platform/json-store'
import { createFakeFs, fakeUpdates } from '../../../support/fake-platform'

describe('createPlatform', () => {
  it('returns the host facts as given and the one set of GitHub transports', () => {
    const host = {
      paths: { userData: '/u', temp: '/t', logs: '/l' },
      info: () => ({ app: '1', electron: '2', node: '3', chromium: '4', commit: null }),
      dialogs: { chooseDirectory: () => Promise.resolve(null), chooseFolder: () => Promise.resolve(null), chooseSavePath: () => Promise.resolve(null) },
      notify: { focused: () => false, show: () => undefined },
      updates: fakeUpdates(),
    }
    const platform = createPlatform(host)
    expect([platform.paths, platform.info, platform.dialogs, platform.notify]).toEqual([host.paths, host.info, host.dialogs, host.notify])
    expect([platform.githubHttp, platform.githubConditional, platform.githubPublic]).toEqual([githubHttp, githubConditional, githubPublic])
  })
})

describe('the fake fs keeps the real adapter contract', () => {
  const cases = [
    { name: 'a missing path is not-found', setup: () => createFakeFs(), expected: 'not-found' },
    {
      name: 'bad JSON is unparseable',
      setup: () => {
        const fs = createFakeFs()
        void fs.writeText('/a/file.json', '{ nope')
        return fs
      },
      path: '/a/file.json',
      expected: 'unparseable',
    },
    {
      name: 'reading a directory is not-a-file',
      setup: () => {
        const fs = createFakeFs()
        void fs.ensureDir('/a/dir')
        return fs
      },
      path: '/a/dir',
      expected: 'not-a-file',
    },
  ] as const

  it.each(cases)('$name', async ({ setup, expected, ...rest }) => {
    const result = await setup().readJson('path' in rest ? rest.path : '/missing.json')
    expect(result.ok === false && result.kind).toBe(expected)
  })

  it('round-trips a value through createJsonStore', async () => {
    const fs = createFakeFs()
    const store = createJsonStore({ file: '/data/store.json', version: 1, schema: z.object({ version: z.literal(1), n: z.number() }), initial: { version: 1 as const, n: 0 }, unreadable: 'reset', fs })
    await store.write({ version: 1, n: 7 })
    const reloaded = createJsonStore({ file: '/data/store.json', version: 1, schema: z.object({ version: z.literal(1), n: z.number() }), initial: { version: 1 as const, n: 0 }, unreadable: 'reset', fs })
    await reloaded.load()
    expect(reloaded.value()).toEqual({ version: 1, n: 7 })
  })
})
