import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildConfigJsonSchema, validateConfig } from '@/main/repos/config/schema'

const ROOT = join(__dirname, '../../../../../../..')
const SCHEMA_PATH = join(ROOT, 'schema/port.config.schema.json')
const FIXTURES = join(ROOT, 'schema/fixtures')

function read(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

describe('the published config schema', () => {
  it('is exactly what the zod source generates', () => {
    expect(read(SCHEMA_PATH), 'run `pnpm --filter @port/desktop schema:config` and commit the result').toEqual(buildConfigJsonSchema())
  })

  it('keeps its published $id', () => {
    expect(buildConfigJsonSchema().$id).toBe('https://raw.githubusercontent.com/b-at-neu/port/main/schema/port.config.schema.json')
  })
})

describe('validateConfig against the schema fixtures', () => {
  const files = readdirSync(FIXTURES).filter((name) => name.endsWith('.json'))

  it.each(files.filter((name) => name.startsWith('valid.')))('accepts %s', (name) => {
    expect(validateConfig(read(join(FIXTURES, name))).violations).toEqual([])
  })

  it.each(files.filter((name) => name.startsWith('invalid.')))('rejects %s', (name) => {
    expect(validateConfig(read(join(FIXTURES, name))).violations.length).toBeGreaterThan(0)
  })

  it('accepts the shipped config template', () => {
    expect(validateConfig(read(join(ROOT, 'plugins/port/templates/port.config.json'))).violations).toEqual([])
  })
})
