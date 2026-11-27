import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { repoId } from '@/main/app/schemas'
import { readyEntryOf } from '@/main/pipeline/context'

const SUBJECT = "'backlog:list'"

export const backlogList = defineAction({
  name: 'backlog.list',
  kind: 'query',
  input: z.object({ repoId }),
  run: async (ctx, input) => {
    const entry = await readyEntryOf(ctx, SUBJECT, input.repoId, (message) => `${SUBJECT} could not list repositories: ${message}`)
    // An unseeded repository tracks nothing yet.
    const refs = ctx.stores.pipelineState.tracked(input.repoId) ?? []
    const tracked = new Set(refs.filter((ref) => ref.kind === 'issue').map((ref) => ref.number))
    return ctx.tracker.listBacklog({ repo: { owner: entry.config.owner, name: entry.config.name }, tracked })
  },
})
