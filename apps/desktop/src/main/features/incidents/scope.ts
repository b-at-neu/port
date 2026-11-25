import { readyEntryOf } from '@/main/pipeline/context'
import type { IncidentLog, IncidentRead } from '@/types/incidents'
import type { RepoId } from '@/utils/repos'

/** A null `repoId` reads every repository; otherwise only the records of its configured slug. */
export async function scopedIncidents(
  ctx: Parameters<typeof readyEntryOf>[0] & { readonly stores: { readonly incidentLog: Pick<IncidentLog, 'read'> } },
  subject: string,
  repoId: RepoId | null,
): Promise<{ readonly slug: string | null; readonly read: IncidentRead }> {
  const slug = repoId === null ? null : (await readyEntryOf(ctx, subject, repoId, (message) => `${subject} could not list repositories: ${message}`)).config.repo
  const read = await ctx.stores.incidentLog.read()
  return { slug, read: read.ok && slug !== null ? { ...read, records: read.records.filter((record) => record.repo === slug) } : read }
}
