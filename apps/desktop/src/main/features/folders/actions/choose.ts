import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'
import { resolveFoldersChoose } from '@/main/channels/workspace'

export const foldersChoose = defineAction({ name: 'folders.choose', kind: 'mutation', input: noInput, run: (ctx, input) => resolveFoldersChoose(ctx.repos.deps, input, ctx.seams.workspace) })
