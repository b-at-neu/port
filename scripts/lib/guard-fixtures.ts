// Shared fixtures for the guard-hook classifier tests split across scripts/checks/
// hooks-classifier.ts, hooks-cockpit-rules.ts, and hooks-gate-rule.ts, colocated outside scripts/checks/ so neither harness.ts nor guards.ts scans it.
import { join } from 'node:path';
import { allowMatchers } from '../../plugins/port/hooks/lib/guard-rules.mjs';
import { root } from './files.ts';

/** Resolves the repository's real Bash allow entries once. `fail` is called
 *  when none are found, matching every caller's own prior behaviour. */
export function resolveMatchers(fail: (check: string, detail: string) => void) {
  const settingsFile = join(root, '.claude/settings.json');
  const matchers = allowMatchers([settingsFile]);
  if (matchers === null) fail('guard-classifier', 'allowMatchers found no Bash allow entries in .claude/settings.json');
  return matchers;
}

// A fixed, synthetic dispatched-agent worktree path, deliberately not derived from `root` —
// reusing `root` could coincidentally satisfy `isOperatorWorktree` depending on the suite's own run directory.
export const subagentPayload = (overrides = {}) => ({
  cwd: '/home/operator/some-project/.claude/worktrees/agent-fixture123',
  session_id: 'sess-1',
  agent_type: 'impl-agent',
  agent_id: 'agent-1',
  tool_name: 'Bash',
  tool_input: { command: 'which claude' },
  ...overrides,
});

export const plainPayload = (overrides = {}) => ({
  cwd: '/home/operator/some-other-project',
  session_id: 'sess-plain',
  tool_name: 'Bash',
  ...overrides,
});

// A fabricated root-level path, not this checkout's own, for the same reason as `subagentPayload` above.
export const operatorWorktreePayload = (overrides = {}) => ({
  cwd: '/home/operator/some-other-project/.claude/worktrees/impl-503',
  session_id: 'sess-implement',
  tool_name: 'Bash',
  ...overrides,
});

// Deliberately neither an `agent-` nor an `impl-` name, isolating `isManagedWorktree` from the two other signals.
export const managedWorktreePayload = (overrides = {}) => ({
  cwd: '/home/operator/some-other-project/.claude/worktrees/other-9',
  session_id: 'sess-worktree',
  tool_name: 'Bash',
  ...overrides,
});

/** `check(label, result, expected)`, bound to a module's own `fail`/`ok`. */
export const makeCheck = (fail: (check: string, detail: string) => void, ok: () => void) => (label: string, result: { decision: string }, expected: string) => {
  if (result.decision !== expected) {
    fail('guard-classifier', `${label}: expected '${expected}', got '${result.decision}'`);
  } else {
    ok();
  }
};

/** Binds a module's repeated `decide({ …fixed-base… })` literal to its own defaults, so each case passes only what differs. */
export const makeDecide = (decide: (args: Record<string, unknown>) => { decision: string; reason?: string }, base: Record<string, unknown>) =>
  (overrides: Record<string, unknown> = {}) => decide({ ...base, ...overrides });

/** A payload shorthand for the common case of varying only the command. */
export const bash = (command: string, payloadFn: (overrides?: object) => object = plainPayload) =>
  payloadFn({ tool_input: { command } });
