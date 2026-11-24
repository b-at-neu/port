// readOwnership / takeOwnership / releaseOwnership over `<base repo root>/.agents/cockpit.json`,
// resolving the base root the same way every worktree of a checkout sees the one record.
import { z } from 'zod'
import type { Platform } from '@/main/platform'
import { resolveGitBaseRoot } from '@/main/platform/git'
import { createJsonStore, type JsonStore } from '@/main/platform/json-store'
import { pathOps } from '@/main/platform/paths'
import type { OwnershipSummary } from '@/types/writes'
import type { TakeOwnershipResult, OwnershipWriteResult, OwnershipParams, OwnershipRead } from '@/types/dispatch'

interface OwnershipRecord {
  readonly repo: string
  readonly owner: 'app'
  readonly since: string
}

interface OwnershipFileShape {
  readonly repo?: unknown
  readonly owner?: unknown
  readonly since?: unknown
}

type OwnershipVerdict =
  | { readonly kind: 'absent' }
  | { readonly kind: 'app'; readonly since: string }
  | { readonly kind: 'unreadable'; readonly message: string }

/** The classification alone, over the parsed file (`undefined` when absent) — a `repo` mismatch reads as
 *  `absent` (a positive determination), and anything else untrustworthy reads as `unreadable`. */
export function classifyOwnership(raw: unknown, repo: string): OwnershipVerdict {
  if (raw === undefined) return { kind: 'absent' }
  if (typeof raw !== 'object' || raw === null) return { kind: 'unreadable', message: 'cockpit.json is not a JSON object' }
  const value = raw as OwnershipFileShape
  if (typeof value.repo !== 'string' || value.repo !== repo) return { kind: 'absent' }
  if (typeof value.since !== 'string') return { kind: 'unreadable', message: "cockpit.json is missing 'since'" }
  if (value.owner === 'app') return { kind: 'app', since: value.since }
  if (value.owner === 'terminal') return { kind: 'unreadable', message: "it names the terminal cockpit as owner — the terminal cockpit can't run a repository this app manages" }
  return { kind: 'unreadable', message: "cockpit.json has an unknown 'owner'" }
}

/** Unversioned, because the guard hook and the stage prompts read the same file and expect no version key; classification stays in `classifyOwnership`. A file that cannot be read is never overwritten. */
function ownershipStore(ctx: Pick<Platform, 'fs'>, path: string): JsonStore<unknown> {
  return createJsonStore<unknown>({ file: path, version: null, schema: z.unknown(), initial: undefined, unreadable: 'read-only', fs: ctx.fs })
}

export async function resolveOwnershipPath(ctx: Pick<Platform, 'git'>, repoRoot: string): Promise<string> {
  const baseRoot = await resolveGitBaseRoot(ctx.git, repoRoot, pathOps)
  return pathOps.join(baseRoot, '.agents', 'cockpit.json')
}

async function load(ctx: Pick<Platform, 'git' | 'fs' | 'clock'>, params: OwnershipParams): Promise<{ readonly read: OwnershipRead; readonly store: JsonStore<unknown>; readonly path: string }> {
  const readAt = ctx.clock.now().toISOString()
  const path = await resolveOwnershipPath(ctx, params.repoRoot)
  const store = ownershipStore(ctx, path)
  await store.load()

  const status = store.status()
  if (status.kind === 'unreadable') return { read: { kind: 'unreadable', message: status.message, path, readAt }, store, path }

  const verdict = classifyOwnership(store.value(), params.repo)
  switch (verdict.kind) {
    case 'absent':
      return { read: { kind: 'absent', path, readAt }, store, path }
    case 'app':
      return { read: { kind: 'app', since: verdict.since, path, readAt }, store, path }
    case 'unreadable':
      return { read: { kind: 'unreadable', message: verdict.message, path, readAt }, store, path }
  }
}

export async function readOwnership(ctx: Pick<Platform, 'git' | 'fs' | 'clock'>, params: OwnershipParams): Promise<OwnershipRead> {
  return (await load(ctx, params)).read
}

/** Drops the path/clock fields — the renderer-safe shape every gate and dispatch surface renders. */
export function toOwnershipSummary(read: OwnershipRead): OwnershipSummary {
  switch (read.kind) {
    case 'absent':
      return { kind: 'absent' }
    case 'app':
      return { kind: 'app', since: read.since }
    case 'unreadable':
      return { kind: 'unreadable', path: read.path, message: read.message }
  }
}

/** Always writes `owner: "app"`, the only owner this process ever claims for itself — no
 *  read-modify-write, since a record carries exactly one owner and `since` always starts fresh. */
export async function takeOwnership(ctx: Pick<Platform, 'git' | 'fs' | 'clock'>, params: OwnershipParams): Promise<TakeOwnershipResult> {
  const { read, store, path } = await load(ctx, params)
  if (read.kind === 'unreadable') return { ok: false, kind: 'refused', verdict: read, path }

  const value: OwnershipRecord = { repo: params.repo, owner: 'app', since: ctx.clock.now().toISOString() }
  const written = await store.write(value)
  if (!written.ok) return { ok: false, kind: 'io', message: written.message, path }
  return { ok: true, path }
}

/** Deletes the record only when the verdict is `app`, never an unreadable one. */
export async function releaseOwnership(ctx: Pick<Platform, 'git' | 'fs' | 'clock'>, params: OwnershipParams): Promise<OwnershipWriteResult> {
  const { read, path } = await load(ctx, params)
  if (read.kind !== 'app') return { ok: true, path }

  const removed = await ctx.fs.remove(path)
  if (!removed.ok && removed.kind !== 'not-found') return { ok: false, kind: 'io', message: removed.message, path }
  return { ok: true, path }
}
