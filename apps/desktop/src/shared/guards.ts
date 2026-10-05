/** A plain JSON object — excludes `null` and arrays, both of which pass
 *  `typeof value === 'object'`. Shared by every adapter that parses an
 *  untrusted JSON payload (`main/hosting/capabilities.ts`,
 *  `main/hosting/project.ts`, `main/sessions/transcript-entries.ts`,
 *  `main/reclaimer/parse.ts`). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
