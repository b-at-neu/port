import { dirname, join } from 'node:path/posix'

export interface SandboxStat {
  uid: number
  mode: number
}

export function isSandboxHelperConfigured(stat: SandboxStat | null): boolean {
  if (stat === null) return false
  return stat.uid === 0 && (stat.mode & 0o7777) === 0o4755
}

export function needsNoSandbox(platform: string, isPackaged: boolean, stat: SandboxStat | null): boolean {
  if (isPackaged || platform !== 'linux') return false
  return !isSandboxHelperConfigured(stat)
}

export function chromeSandboxPath(electronBinary: string): string {
  return join(dirname(electronBinary), 'chrome-sandbox')
}
