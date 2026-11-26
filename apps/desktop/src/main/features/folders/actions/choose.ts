import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'
import { chooseFolder } from '@/main/features/folders/resolve'

export const foldersChoose = defineAction({ name: 'folders.choose', kind: 'mutation', input: noInput, run: (ctx) => chooseFolder(ctx) })
