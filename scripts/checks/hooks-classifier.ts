import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from '../lib/files.ts';
import { resolveMatchers, subagentPayload, makeCheck, makeDecide } from '../lib/guard-fixtures.ts';
import type { Reporter } from '../lib/report.ts';

export default async function ({ fail, ok, expect }: Reporter) {
  // --- Guard hook classifier ---------------------------------------------------
  // guard(#67): the mechanism that actually denies, independent of
  // parent-session mode. Unit-tests the pure decision logic in isolation
  // from stdin/stdout/exit-code plumbing.
  const { decide, callerKind, globToRegExp } =
    await import(pathToFileURL(join(root, 'plugins/port/hooks/lib/guard-rules.mjs')).href);

  const matchers = resolveMatchers(fail);
  const check = makeCheck(fail, ok);
  const gate = makeDecide(decide, { matchers, sessionRequiredPaths: [], root });

  // Subagent + non-allowlisted Bash → deny.
  check('subagent non-allowlisted bash', gate({ payload: subagentPayload() }), 'deny');

  // Same command, no agent signal → miss, never deny. A fabricated cwd, not
  // this checkout's own path — this script may itself be running inside a
  // dispatched agent's worktree, whose path legitimately matches the
  // worktree signal, which would otherwise make this case pass for the
  // wrong reason.
  check(
    'no-signal non-allowlisted bash',
    gate({
      payload: {
        cwd: '/home/operator/some-other-project',
        session_id: 'sess-2',
        tool_name: 'Bash',
        tool_input: { command: 'which claude' },
      },
    }),
    'miss',
  );

  // Allowlisted command with an agent signal → allow.
  check(
    'subagent allowlisted bash',
    gate({ payload: subagentPayload({ tool_input: { command: 'git status' } }) }),
    'allow',
  );

  // Subagent write to a sessionRequiredPaths path → deny.
  check(
    'subagent write to session-required path',
    gate({
      payload: subagentPayload({
        tool_name: 'Write',
        tool_input: { file_path: join(root, '.claude/port.config.json') },
      }),
      sessionRequiredPaths: ['CLAUDE.md', '.claude/**'],
    }),
    'deny',
  );

  // Subagent write outside sessionRequiredPaths → allow.
  check(
    'subagent write outside session-required paths',
    gate({
      payload: subagentPayload({
        tool_name: 'Write',
        tool_input: { file_path: join(root, 'plugins/port/x.md') },
      }),
      sessionRequiredPaths: ['CLAUDE.md', '.claude/**'],
    }),
    'allow',
  );

  // The transcript and worktree signals each reach 'deny' on their own,
  // with no agent_type/agent_id present.
  check(
    'transcript signal alone',
    gate({
      payload: {
        cwd: root,
        session_id: 'sess-3',
        transcript_path: '/home/x/.claude/subagents/agent-abc123.jsonl',
        tool_name: 'Bash',
        tool_input: { command: 'which claude' },
      },
    }),
    'deny',
  );
  check(
    'worktree signal alone',
    gate({
      payload: {
        cwd: join(root, '.claude/worktrees/agent-abc123'),
        session_id: 'sess-4',
        tool_name: 'Bash',
        tool_input: { command: 'which claude' },
      },
    }),
    'deny',
  );

  // callerKind never string-matches a stage name — a namespaced agentType
  // still resolves via the agent_type signal.
  if (!callerKind({ agent_type: 'port:plan-agent' }).isSubagent) {
    fail('guard-classifier', 'callerKind missed a namespaced agent_type');
  }
  ok();

  // globToRegExp: '**' spans directories, '*' does not.
  if (!globToRegExp('.claude/**').test('.claude/settings.json')) {
    fail('guard-classifier', "globToRegExp('.claude/**') should match '.claude/settings.json'");
  }
  if (globToRegExp('.claude/*').test('.claude/a/b')) {
    fail('guard-classifier', "globToRegExp('.claude/*') should not cross a directory boundary");
  }
  ok();
}
