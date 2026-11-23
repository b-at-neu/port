import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'
import { resolveStorageReport } from '@/main/features/storage/resolve'
import { directorySize } from '@/main/platform/disk'
import { defaultClaudeHome } from '@/main/sessions/locate'
import { listRepositories } from '@/main/registry'

export const storageReport = defineAction({
  name: 'storage.report',
  kind: 'query',
  input: noInput,
  run: (ctx, input) => resolveStorageReport(ctx.repos.deps, input, { listRepositories, directorySize, userData: ctx.paths.userData, logs: ctx.paths.logs, claudeHome: defaultClaudeHome }),
})
