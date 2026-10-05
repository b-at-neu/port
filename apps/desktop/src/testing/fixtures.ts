import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function makeTempDir(prefix = 'port-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

export async function makeClaudeHome(credentials?: unknown): Promise<string> {
  const dir = await makeTempDir('port-claude-home-')
  if (credentials !== undefined) {
    await writeFile(join(dir, '.credentials.json'), typeof credentials === 'string' ? credentials : JSON.stringify(credentials), 'utf8')
  }
  return dir
}
