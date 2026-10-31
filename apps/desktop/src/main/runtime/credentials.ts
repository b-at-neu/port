// A best-effort, read-only tell of the CLI's own OAuth credentials file — never a token value, nothing logged. macOS keeps this file in the Keychain instead, so a missing file falls through to the probe rather than trusting either reading of an absent file.
import { readJsonFile } from '@/main/platform/files'
import { defaultClaudeHome } from '@/main/sessions/locate'
import { pathOps } from '@/main/platform/paths'
import type { CredentialsTell } from '@/types/runtime'

/** Any missing or malformed field yields `present: false` rather than a thrown error — this read is advisory-only. */
interface CredentialsFileShape {
  readonly claudeAiOauth?: {
    readonly accessToken?: string
    readonly refreshToken?: string
    readonly expiresAt?: number
  }
}

const NOT_PRESENT: CredentialsTell = { present: false, expiresAt: null, hasRefreshToken: false }

interface ReadCredentialsTellOptions {
  readonly claudeHome?: string
}

export async function readCredentialsTell(options: ReadCredentialsTellOptions = {}): Promise<CredentialsTell> {
  const claudeHome = options.claudeHome ?? defaultClaudeHome()
  const path = pathOps.join(claudeHome, '.credentials.json')
  const result = await readJsonFile<CredentialsFileShape>(path)
  if (!result.ok) return NOT_PRESENT

  const oauth = result.value.claudeAiOauth
  if (typeof oauth !== 'object' || oauth === null) return NOT_PRESENT

  return {
    present: true,
    expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null,
    hasRefreshToken: typeof oauth.refreshToken === 'string' && oauth.refreshToken !== '',
  }
}
