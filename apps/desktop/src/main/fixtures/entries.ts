// Fixture mode's canned transcript entries — the streaming session's own
// replay, plus the resumed session's history backfill.
import type { TranscriptEntry } from '../../shared/sessions/transcript'

const MINUTE = 60_000

function payload(text: string) {
  return { text, omittedChars: 0 }
}

export function fixtureAttachEntries(now: Date): readonly TranscriptEntry[] {
  const t = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * MINUTE).toISOString()
  return [
    { type: 'user-text', uuid: 'fixture-1', timestamp: t(4), text: payload('Add a loading state to the repositories table.') },
    { type: 'assistant-text', uuid: 'fixture-2', timestamp: t(3), text: payload("I'll add a `Skeleton` row while the query is pending.") },
    {
      type: 'tool-call',
      uuid: 'fixture-3',
      timestamp: t(2),
      name: 'Edit',
      headline: 'src/renderer/src/repositories/screen.tsx',
      input: payload('{"file_path":"src/renderer/src/repositories/screen.tsx"}'),
      result: { isError: false, payload: payload('Edit applied.') },
      diff: {
        path: 'src/renderer/src/repositories/screen.tsx',
        isNewFile: false,
        additions: 2,
        deletions: 1,
        hunks: [
          {
            oldStart: 10,
            oldLines: 1,
            newStart: 10,
            newLines: 2,
            lines: [
              { sign: 'del', text: '-  if (loading) return null' },
              { sign: 'add', text: '+  if (loading) return <Skeleton className="h-9 w-full" />' },
              { sign: 'add', text: '+  // loading state' },
            ],
          },
        ],
      },
    },
    { type: 'thinking', uuid: 'fixture-4', timestamp: t(1), text: payload('Checking whether any other screen already renders this pattern.') },
    {
      type: 'tool-call',
      uuid: 'fixture-5',
      timestamp: t(1),
      name: 'Bash',
      headline: 'pnpm --filter @port/desktop test',
      input: payload('{"command":"pnpm --filter @port/desktop test"}'),
      result: { isError: false, payload: payload('42 passed') },
      diff: null,
      toolUseId: 'fixture-tool-bash-ok',
      detail: { kind: 'bash', command: 'pnpm --filter @port/desktop test', exitCode: 0, interrupted: false },
    },
    {
      type: 'tool-call',
      uuid: 'fixture-6',
      timestamp: t(1),
      name: 'Bash',
      headline: 'pnpm lint',
      input: payload('{"command":"pnpm lint"}'),
      result: { isError: true, payload: payload('1 problem (1 error, 0 warnings)') },
      diff: null,
      toolUseId: 'fixture-tool-bash-fail',
      detail: { kind: 'bash', command: 'pnpm lint', exitCode: 1, interrupted: false },
    },
    {
      type: 'tool-call',
      uuid: 'fixture-7',
      timestamp: t(1),
      name: 'Read',
      headline: 'src/renderer/src/repositories/screen.tsx',
      input: payload('{"file_path":"src/renderer/src/repositories/screen.tsx"}'),
      result: { isError: false, payload: payload('120 lines') },
      diff: null,
      toolUseId: 'fixture-tool-read',
      detail: { kind: 'lookup', count: 120 },
    },
    {
      type: 'tool-call',
      uuid: 'fixture-8',
      timestamp: t(1),
      name: 'Grep',
      headline: 'Skeleton src/renderer',
      input: payload('{"pattern":"Skeleton","path":"src/renderer"}'),
      result: { isError: false, payload: payload('14 matches') },
      diff: null,
      toolUseId: 'fixture-tool-grep',
      detail: { kind: 'lookup', count: 14 },
    },
    {
      type: 'tool-call',
      uuid: 'fixture-9',
      timestamp: t(1),
      name: 'Glob',
      headline: '**/*.test.ts',
      input: payload('{"pattern":"**/*.test.ts"}'),
      result: { isError: false, payload: payload('No files') },
      diff: null,
      toolUseId: 'fixture-tool-glob',
      detail: { kind: 'lookup', count: 0 },
    },
    {
      type: 'tool-call',
      uuid: 'fixture-10',
      timestamp: t(1),
      name: 'TodoWrite',
      headline: '3 todos',
      input: payload('{"todos":[]}'),
      result: { isError: false, payload: payload('ok') },
      diff: null,
      toolUseId: 'fixture-tool-todos',
      detail: {
        kind: 'todos',
        items: [
          { content: 'Add the Skeleton row', status: 'completed' },
          { content: 'Add a regression test', status: 'in_progress' },
          { content: 'Update the screenshot', status: 'pending' },
        ],
        droppedCount: 0,
      },
    },
    {
      type: 'tool-call',
      uuid: 'fixture-11',
      timestamp: t(1),
      name: 'Task',
      headline: 'Read the two config files',
      input: payload('{"description":"Read the two config files","subagent_type":"general"}'),
      result: { isError: false, payload: payload('Both files use the same schema version.') },
      diff: null,
      toolUseId: 'fixture-tool-task',
      detail: { kind: 'task', description: 'Read the two config files', subagentType: 'general' },
    },
    {
      type: 'tool-call',
      uuid: 'fixture-12',
      parentToolUseId: 'fixture-tool-task',
      timestamp: t(1),
      name: 'Read',
      headline: 'apps/desktop/package.json',
      input: payload('{"file_path":"apps/desktop/package.json"}'),
      result: { isError: false, payload: payload('40 lines') },
      diff: null,
      toolUseId: 'fixture-tool-task-child-read',
      detail: { kind: 'lookup', count: 40 },
    },
    { type: 'assistant-text', uuid: 'fixture-13', parentToolUseId: 'fixture-tool-task', timestamp: t(1), text: payload('Both files use the same schema version.') },
    {
      type: 'assistant-text',
      uuid: 'fixture-14',
      timestamp: t(0),
      text: payload('Here is the updated loading state:\n\n```ts\nif (loading) return <Skeleton className="h-9 w-full" />\n```'),
    },
  ]
}

export function fixtureHistoryEntries(now: Date): readonly TranscriptEntry[] {
  const t = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * MINUTE).toISOString()
  return [
    { type: 'user-text', uuid: 'fixture-history-entry-1', timestamp: t(95), text: payload('Build the Worktrees tab.') },
    { type: 'assistant-text', uuid: 'fixture-history-entry-2', timestamp: t(93), text: payload("I'll add a Worktrees tab to the Repositories screen.") },
    { type: 'meta', uuid: 'fixture-history-entry-3', timestamp: t(91), label: 'Turn complete · 120.0 s' },
  ]
}
