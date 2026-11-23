import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { repoId } from '@/main/app/schemas'
import { resolveReleaseRun } from '@/main/features/release/resolve'

const MAX_NOTES_CHARS = 125_000

export const releaseRun = defineAction({
  name: 'release.run',
  kind: 'mutation',
  input: z.discriminatedUnion('step', [
    z.object({ repoId, step: z.literal('open'), version: z.string() }),
    z.object({ repoId, step: z.literal('publish'), version: z.string(), notes: z.string().refine((notes) => notes.trim() !== '' && notes.length <= MAX_NOTES_CHARS, { message: `must be 1 to ${String(MAX_NOTES_CHARS)} characters` }) }),
  ]),
  run: (ctx, input) => resolveReleaseRun(ctx.repos.deps, input, ctx.paths.userData, ctx.paths.temp),
})
