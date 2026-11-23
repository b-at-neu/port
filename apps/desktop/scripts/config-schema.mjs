// Writes schema/port.config.schema.json from the zod source. Run as `pnpm --filter @port/desktop schema:config`.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildConfigJsonSchema } from '../src/main/registry/schema.ts'

const PRIMITIVE = String.raw`(?:"(?:[^"\\\n]|\\.)*"|true|false|null|-?\d+)`
const SHORT_ARRAY = new RegExp(String.raw`\[\n\s+(${PRIMITIVE}(?:,\n\s+${PRIMITIVE})*)\n\s*\]`, 'g')

/** Arrays of primitives stay on one line, so the generated file reads like the hand-written one it replaced. */
const format = (value) => JSON.stringify(value, null, 2).replace(SHORT_ARRAY, (_match, items) => `[${items.replace(/,\n\s+/g, ', ')}]`)

const target = fileURLToPath(new globalThis.URL('../../../schema/port.config.schema.json', import.meta.url))
writeFileSync(target, `${format(buildConfigJsonSchema())}\n`)
console.log(`wrote ${target}`)
