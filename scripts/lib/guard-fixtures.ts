// Shared fixtures for the guard-hook classifier tests split across
// scripts/checks/hooks-classifier.ts, hooks-cockpit-rules.ts, and
// hooks-gate-rule.ts (#181) — the payload factories and the `check()`
// helper each of those three files needs, colocated here (outside
// scripts/checks/, so neither harness.ts nor guards.ts scans it) rather
// than reimplemented three times and drifting.
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

// A fixed, synthetic dispatched-agent worktree path — deliberately not
// derived from `root`. `root` is wherever this script actually runs from,
// which for a SESSION REQUIRED ticket is an `/port:implement` `impl-<n>`
// worktree (this very ticket's own testing step runs from one) — reusing
// it here would coincidentally satisfy `isOperatorWorktree` and silently
// change what several cases below are actually testing, depending on
// nothing but the directory the suite happens to run in.
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

// A fabricated root-level path, not this checkout's own — this script may
// itself be running inside a dispatched agent's worktree
// (`.claude/worktrees/agent-<hash>`), whose ancestor path would otherwise
// make `.claude/worktrees/impl-503` match the *agent* worktree signal too,
// for the wrong reason. Same rationale as `subagentPayload` above.
export const operatorWorktreePayload = (overrides = {}) => ({
  cwd: '/home/operator/some-other-project/.claude/worktrees/impl-503',
  session_id: 'sess-implement',
  tool_name: 'Bash',
  ...overrides,
});

// Deliberately neither an `agent-` nor an `impl-` name — a naming scheme
// this repository's harness doesn't use, so this isolates
// `isManagedWorktree` (any `.claude/worktrees/` path) from the two *other*
// signals (`isSubagent` via `agent-`, `isOperatorWorktree` via `impl-`)
// that would otherwise make a case pass for the wrong reason.
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
