import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { positiveInt, repoId } from '@/main/app/schemas'
import { fetchBacklogDetail } from '@/main/github/tracker/backlog-detail'
import { readyEntryOf } from '@/main/pipeline/context'

const SUBJECT = "'backlog:detail'"

export const backlogDetail = defineAction({
  name: 'backlog.detail',
  kind: 'query',
  input: z.object({ repoId, number: positiveInt }),
  run: async (ctx, input) => {
    const entry = await readyEntryOf(ctx, SUBJECT, input.repoId, (message) => `${SUBJECT} could not list repositories: ${message}`)
    return fetchBacklogDetail(ctx, { repo: { owner: entry.config.owner, name: entry.config.name }, number: input.number })
  },
})
