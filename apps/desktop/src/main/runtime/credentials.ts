// #97: a best-effort, read-only tell of the CLI's own OAuth credentials
// file — never a token value, and nothing here is logged. Reuses
// `defaultClaudeHome()` (#83) rather than re-reading `CLAUDE_CONFIG_DIR` a
// second time, the same single-source-of-truth rule `locate.ts` states for
// itself's sibling module. macOS keeps this file in the Keychain instead,
// so a missing file is `unknown`, never `unauthenticated` — the caller's
// classification ladder falls through to the probe rather than trusting
// either reading of an absent file.
import { readJsonFile } from '../platform'
import { defaultClaudeHome } from '../sessions'
import { pathOps } from '../platform'
import type { CredentialsTell } from '../../shared/runtime/types'

/** The on-disk shape this file defends against being wrong about: any
 *  missing or malformed field yields `present: false` rather than a thrown
 *  error, since this read is advisory-only wherever the classification
 *  ladder cannot otherwise decide. */
interface CredentialsFileShape {
  readonly claudeAiOauth?: {
    readonly accessToken?: string
    readonly refreshToken?: string
    readonly expiresAt?: number
  }
}

const NOT_PRESENT: CredentialsTell = { present: false, expiresAt: null, hasRefreshToken: false }

export interface ReadCredentialsTellOptions {
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
