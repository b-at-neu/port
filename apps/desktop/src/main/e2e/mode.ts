// Pure, the same shape as fixtures/mode.ts.
export const E2E_ENV = { flag: 'PORT_E2E', userData: 'PORT_E2E_USER_DATA', fake: 'PORT_E2E_FAKE' } as const

export type E2EModeResult =
  | { readonly kind: 'off' }
  | { readonly kind: 'ignored' }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'on'; readonly userData: string; readonly fake: string }

// Fails closed rather than guessing a directory or fake path; E2E and fixture mode never combine.
export function e2eMode(env: Readonly<Record<string, string | undefined>>, isPackaged: boolean, isAbsolute: (path: string) => boolean): E2EModeResult {
  if (env[E2E_ENV.flag] !== '1') return { kind: 'off' }
  if (isPackaged) return { kind: 'ignored' }

  if (env['PORT_FIXTURES'] === '1') {
    return { kind: 'invalid', reason: `${E2E_ENV.flag} and PORT_FIXTURES must never both be set` }
  }

  const userData = env[E2E_ENV.userData]
  if (userData === undefined || userData === '' || !isAbsolute(userData)) {
    return { kind: 'invalid', reason: `${E2E_ENV.userData} must be set to an absolute path` }
  }

  const fake = env[E2E_ENV.fake]
  if (fake === undefined || fake === '' || !isAbsolute(fake)) {
    return { kind: 'invalid', reason: `${E2E_ENV.fake} must be set to an absolute path` }
  }

  return { kind: 'on', userData, fake }
}
