import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'
import { readStorageReport } from '@/main/features/storage/resolve'

export const storageReport = defineAction({
  name: 'storage.report',
  kind: 'query',
  input: noInput,
  run: (ctx) => readStorageReport(ctx),
})
