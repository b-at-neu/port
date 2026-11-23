// The incident channels' composition: validate the request, resolve the repository, then read the log.
import { exportDocument, groupIncidents } from '@/main/incidents/group'
import { requireReadyRepo, requireRepoId } from '@/main/registry'
import type { IncidentChannelDeps } from '@/main/app/seams'
import type { RepoId } from '@/utils/repos'
import { INCIDENT_LIST_LIMIT, type IncidentExportResult, type IncidentGroupsRead, type IncidentListRead, type IncidentRead } from '@/types/incidents'
import type { RegistryDeps } from '@/types/registry'

const SIGNATURE_MAX = 200

// A non-null `repoId` must name a registered, `ready` repository; the slug is read from its own config, never the request.
async function slugOf(registryDeps: RegistryDeps, channel: string, repoId: unknown, deps: IncidentChannelDeps): Promise<string | null> {
  if (repoId === null) return null
  const entry = await requireReadyRepo(registryDeps, channel, requireRepoId(repoId, channel), deps.listRepositories)
  return entry.config.repo
}

function scoped(read: IncidentRead, slug: string | null): IncidentRead {
  return read.ok && slug !== null ? { ...read, records: read.records.filter((record) => record.repo === slug) } : read
}

export async function resolveIncidentGroups(registryDeps: RegistryDeps, request: { readonly repoId: RepoId | null }, deps: IncidentChannelDeps): Promise<IncidentGroupsRead> {
  const slug = await slugOf(registryDeps, "'incidents:groups'", request?.repoId, deps)
  const read = scoped(await deps.log.read(), slug)
  return read.ok ? { ok: true, groups: groupIncidents(read.records), malformed: read.malformed, pruned: read.pruned, readAt: read.readAt } : read
}

export async function resolveIncidentList(registryDeps: RegistryDeps, request: { readonly repoId: RepoId | null; readonly signature: string }, deps: IncidentChannelDeps): Promise<IncidentListRead> {
  const signature: unknown = request?.signature
  if (typeof signature !== 'string' || signature === '' || signature.length >= SIGNATURE_MAX) throw new Error(`'incidents:list' requires a non-empty 'signature' under ${String(SIGNATURE_MAX)} characters`)
  const slug = await slugOf(registryDeps, "'incidents:list'", request.repoId, deps)
  const read = scoped(await deps.log.read(), slug)
  if (!read.ok) return read
  return { ok: true, records: read.records.filter((record) => record.signature === signature).slice(-INCIDENT_LIST_LIMIT).reverse(), readAt: read.readAt }
}

export async function resolveIncidentExport(registryDeps: RegistryDeps, request: { readonly repoId: RepoId | null }, deps: IncidentChannelDeps): Promise<IncidentExportResult> {
  const slug = await slugOf(registryDeps, "'incidents:export'", request?.repoId, deps)
  const read = scoped(await deps.log.read(), slug)
  if (!read.ok) return { ok: false, kind: 'io', message: read.message }
  const now = deps.now()
  const path = await deps.chooseSavePath(`port-incidents-${now.toISOString().slice(0, 10)}.json`)
  if (path === null) return { ok: false, kind: 'cancelled' }
  const written = await deps.writeJson(path, exportDocument(groupIncidents(read.records), read, slug, now))
  return written.ok ? { ok: true, path } : { ok: false, kind: 'io', message: written.message }
}
