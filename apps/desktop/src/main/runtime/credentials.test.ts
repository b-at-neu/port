import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readCredentialsTell } from './credentials'

async function makeClaudeHome(credentials: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'port-runtime-credentials-'))
  if (credentials !== undefined) {
    await writeFile(join(dir, '.credentials.json'), typeof credentials === 'string' ? credentials : JSON.stringify(credentials), 'utf8')
  }
  return dir
}

describe('readCredentialsTell', () => {
  it('a healthy token reports present, its expiresAt, and hasRefreshToken', async () => {
    const claudeHome = await makeClaudeHome({ claudeAiOauth: { accessToken: 'sk-ant-oat-x', refreshToken: 'sk-ant-ort-x', expiresAt: 4102444800000 } })
    const tell = await readCredentialsTell({ claudeHome })
    expect(tell).toEqual({ present: true, expiresAt: 4102444800000, hasRefreshToken: true })
  })

  it('#145: expiresAt 0 with a refresh token present is still just a reading -- classification is classify.ts\'s job, not this one', async () => {
    const claudeHome = await makeClaudeHome({ claudeAiOauth: { accessToken: 'sk-ant-oat-x', refreshToken: 'sk-ant-ort-x', expiresAt: 0 } })
    const tell = await readCredentialsTell({ claudeHome })
    expect(tell).toEqual({ present: true, expiresAt: 0, hasRefreshToken: true })
  })

  it('an absent .credentials.json (the macOS Keychain case) is present: false, never thrown', async () => {
    const claudeHome = await makeClaudeHome(undefined)
    const tell = await readCredentialsTell({ claudeHome })
    expect(tell).toEqual({ present: false, expiresAt: null, hasRefreshToken: false })
  })

  it('malformed JSON is present: false, never thrown', async () => {
    const claudeHome = await makeClaudeHome('{not json')
    const tell = await readCredentialsTell({ claudeHome })
    expect(tell).toEqual({ present: false, expiresAt: null, hasRefreshToken: false })
  })

  it('a well-formed file missing claudeAiOauth entirely is present: false', async () => {
    const claudeHome = await makeClaudeHome({ somethingElse: true })
    const tell = await readCredentialsTell({ claudeHome })
    expect(tell).toEqual({ present: false, expiresAt: null, hasRefreshToken: false })
  })

  it('no token value ever appears in the returned tell', async () => {
    const claudeHome = await makeClaudeHome({ claudeAiOauth: { accessToken: 'sk-ant-oat-super-secret', refreshToken: 'sk-ant-ort-super-secret', expiresAt: 123 } })
    const tell = await readCredentialsTell({ claudeHome })
    expect(JSON.stringify(tell)).not.toContain('super-secret')
  })
})
