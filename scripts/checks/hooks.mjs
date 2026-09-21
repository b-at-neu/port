import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root, readJson } from '../lib/files.mjs';

// The guard hook's classifier tests live in scripts/checks/hooks-classifier.mjs,
// scripts/checks/hooks-cockpit-rules.mjs, and scripts/checks/hooks-gate-rule.mjs
// (issue 181, splitting this module's own file-size ratchet entry) — this module
// keeps the hook as a declared artifact: its command shape, its PreToolUse
// wiring, and the end-to-end stdin/stdout/exit-code spawn.
export default async function ({ fail, ok }) {
  // --- hooks.json command shape ----------------------------------------------
  // guard: the hook loading as Hooks (0) — no error, just absent. Regression
  // test for the argv-array form.
  {
    const hooks = readJson('plugins/port/hooks/hooks.json');
    const entries = Object.values(hooks.hooks ?? {}).flat();
    if (entries.length === 0) fail('hooks', 'hooks.json declares no hooks');
    for (const matcher of entries) {
      for (const h of matcher.hooks ?? []) {
        if (typeof h.command !== 'string') {
          fail(
            'hooks',
            `command must be a shell string, got ${Array.isArray(h.command) ? 'an array' : typeof h.command}`,
          );
        }
        ok();
      }
    }
  }

  // --- Guard hook is wired on PreToolUse for Bash and the write tools --------
  // guard(#67): the guard hook silently absent after a rename or a dropped
  // matcher — nothing errors, it simply never fires. The deny is a hook
  // decision now, not a prediction from `dontAsk`.
  {
    const hooksJson = readJson('plugins/port/hooks/hooks.json');
    const entries = Object.entries(hooksJson.hooks ?? {});

    for (const [event, matchers] of entries) {
      for (const matcher of matchers) {
        for (const h of matcher.hooks ?? []) {
          const m = /\$\{CLAUDE_PLUGIN_ROOT\}\/(.+?)"/.exec(h.command ?? '');
          const rel = m?.[1];
          if (!rel || !existsSync(join(root, 'plugins/port', rel))) {
            fail('hook-wiring', `${event}/${matcher.matcher}: command references a missing file (${JSON.stringify(h.command)})`);
          } else {
            ok();
          }
        }
      }
    }

    const preToolUse = hooksJson.hooks?.PreToolUse ?? [];
    const coversBash = preToolUse.some((m) => m.matcher === 'Bash');
    const coversWrites = preToolUse.some((m) => /\bEdit\b/.test(m.matcher ?? '') && /\bWrite\b/.test(m.matcher ?? ''));
    if (!coversBash) fail('hook-wiring', 'PreToolUse declares no matcher covering Bash');
    if (!coversWrites) fail('hook-wiring', 'PreToolUse declares no matcher covering the write tools (Edit/Write/NotebookEdit)');
    ok();
  }

  // --- Guard hook end-to-end wiring -------------------------------------------
  // guard(#67): stdin/stdout/exit-code wiring the classifier's direct import
  // cannot see. The fixture directory must sit outside any git repository,
  // or `git rev-parse --git-common-dir` resolves to this checkout.
  {
    const hookPath = join(root, 'plugins/port/hooks/agent-guard.mjs');
    const fixture = mkdtempSync(join(tmpdir(), 'port-guard-hook-'));
    try {
      mkdirSync(join(fixture, '.claude'), { recursive: true });
      writeFileSync(join(fixture, '.claude', 'port.config.json'), '{"sessionRequiredPaths":["CLAUDE.md",".claude/**"]}');
      writeFileSync(
        join(fixture, '.claude', 'settings.json'),
        JSON.stringify({ permissions: { allow: ['Bash(git *)'] } }),
      );

      const run = (payload) =>
        execFileSync(process.execPath, [hookPath], {
          cwd: fixture,
          input: JSON.stringify(payload),
          stdio: ['pipe', 'pipe', 'ignore'],
          encoding: 'utf8',
        });
      const readLog = () => {
        const p = join(fixture, '.agents', 'denials.log');
        return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean) : [];
      };

      // Subagent, non-allowlisted Bash → stdout carries the deny JSON, log gets a 'deny' line.
      let stdout = run({
        cwd: fixture,
        session_id: 'sess-1',
        agent_id: 'agent-1',
        agent_type: 'impl-agent',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' },
      });
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        fail('guard-hook-fixture', `expected JSON deny output, got ${JSON.stringify(stdout)}`);
      }
      if (parsed && parsed.hookSpecificOutput?.permissionDecision !== 'deny') {
        fail('guard-hook-fixture', `expected permissionDecision 'deny', got ${JSON.stringify(parsed)}`);
      }
      let lines = readLog();
      if (lines.length !== 1) fail('guard-hook-fixture', `expected 1 log line after a subagent deny, got ${lines.length}`);
      else if (lines[0].split('\t').length !== 4) fail('guard-hook-fixture', `expected 4 tab-separated fields, got ${JSON.stringify(lines[0])}`);
      else if (!lines[0].includes('\tdeny\t')) fail('guard-hook-fixture', `expected a 'deny' line, got ${JSON.stringify(lines[0])}`);
      else if (!lines[0].includes('\tport:impl-agent\t')) fail('guard-hook-fixture', `expected actor 'port:impl-agent', got ${JSON.stringify(lines[0])}`);
      ok();

      // Non-subagent, non-allowlisted Bash → no stdout, log gets a 'miss' line.
      stdout = run({
        cwd: fixture,
        session_id: 'sess-2',
        tool_name: 'Bash',
        tool_input: { command: 'gh pr merge 1' },
      });
      if (stdout.trim() !== '') fail('guard-hook-fixture', `expected no stdout for a non-subagent miss, got ${JSON.stringify(stdout)}`);
      lines = readLog();
      if (lines.length !== 2) fail('guard-hook-fixture', `expected 2 lines after a non-subagent miss, got ${lines.length}`);
      else if (!lines[1].includes('\tmiss\t')) fail('guard-hook-fixture', `expected a 'miss' line, got ${JSON.stringify(lines[1])}`);
      ok();

      // Allowlisted Bash → no stdout, nothing logged (an 'allow' is never logged).
      run({ cwd: fixture, session_id: 'sess-3', tool_name: 'Bash', tool_input: { command: 'git status' } });
      if (readLog().length !== 2) fail('guard-hook-fixture', 'an allowed command should not append a line');
      ok();

      // No port.config.json in cwd → silent, nothing written.
      const unmanaged = mkdtempSync(join(tmpdir(), 'port-guard-hook-unmanaged-'));
      try {
        execFileSync(process.execPath, [hookPath], {
          cwd: unmanaged,
          input: JSON.stringify({ cwd: unmanaged, session_id: 'sess-4', tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }),
          stdio: ['pipe', 'ignore', 'ignore'],
        });
        if (existsSync(join(unmanaged, '.agents', 'denials.log'))) {
          fail('guard-hook-fixture', 'wrote a log file outside a port-managed repository');
        }
        ok();
      } finally {
        rmSync(unmanaged, { recursive: true, force: true, maxRetries: 3 });
      }

      // Malformed payload → fails open, logs 'hook-error'.
      execFileSync(process.execPath, [hookPath], {
        cwd: fixture,
        input: 'not json',
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      lines = readLog();
      if (lines.length !== 3) fail('guard-hook-fixture', `expected a hook-error line for a malformed payload, got ${lines.length} lines`);
      else if (!lines[2].includes('\thook-error\t')) fail('guard-hook-fixture', `expected a 'hook-error' line, got ${JSON.stringify(lines[2])}`);
      ok();
    } catch (e) {
      if (e.status !== undefined) fail('guard-hook-fixture', `hook exited non-zero: ${e.message}`);
      else throw e;
    } finally {
      rmSync(fixture, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}
