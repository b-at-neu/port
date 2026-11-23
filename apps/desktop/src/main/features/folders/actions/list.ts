import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'
import { resolveFoldersList } from '@/main/channels/workspace'

export const foldersList = defineAction({ name: 'folders.list', kind: 'query', input: noInput, run: (ctx, input) => resolveFoldersList(ctx.repos.deps, input, ctx.seams.workspace) })
