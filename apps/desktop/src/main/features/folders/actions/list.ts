import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'
import { listFolders } from '@/main/features/folders/resolve'

export const foldersList = defineAction({ name: 'folders.list', kind: 'query', input: noInput, run: (ctx) => listFolders(ctx) })
