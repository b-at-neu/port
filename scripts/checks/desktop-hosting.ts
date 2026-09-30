import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, readJson, walk, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// #98/#99: apps/desktop/src/main/hosting/ owns the full lifecycle of a
// hosted session in the main process. Thirteen assertions pin its plan's
// decisions mechanically, in the shape desktop-runtime.ts's and
// desktop-sessions.ts's own guards already use.
export default async function ({ fail, ok }: Reporter) {
  const hostingDir = 'apps/desktop/src/main/hosting';
  const sharedHostingDir = 'apps/desktop/src/shared/hosting';
  const srcDir = join(root, 'apps/desktop/src');
  const allFiles = walk(srcDir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
  const hostingFiles = allFiles.filter((f) => relOf(f).startsWith(`${hostingDir}/`));
  const hostingProdFiles = hostingFiles.filter((f) => !relOf(f).endsWith('.test.ts'));

  // --- No string prompt anywhere under main/hosting/ -----------------------
  // guard(#98): streaming input mode, always — `interrupt()`/
  // `setPermissionMode()` are documented as "only supported when streaming
  // input/output is used", so a string `prompt` would silently make Stop
  // impossible. Matched as the `prompt:` option key followed by a quote or
  // backtick, never the substring `prompt` alone (which appears in prose and
  // in `PROBE_PROMPT`-shaped identifiers elsewhere).
  {
    const stringPromptRe = /\bprompt\s*:\s*['"`]/;
    let found = false;
    for (const f of hostingProdFiles) {
      const rel = relOf(f);
      const code = stripComments(readFileSync(f, 'utf8'));
      if (stringPromptRe.test(code)) {
        found = true;
        fail('desktop-hosting', `${rel} passes a string 'prompt:' — streaming input mode must stay the only prompt shape under main/hosting/ (a string prompt disables Stop)`);
      }
    }
    if (!found) ok();
  }

  // --- No direct process control under main/hosting/ -----------------------
  // guard(#98): the SDK owns termination — never `process.kill`, never a
  // signal, never a raw `node:child_process`/`node:fs` reach-around. This is
  // what makes close() identical on Windows (the SDK ends stdin rather than
  // sending SIGTERM there).
  {
    const forbidden = ["'node:child_process'", '"node:child_process"', "'node:fs'", '"node:fs"', 'process.kill', '.kill('];
    let found = false;
    for (const f of hostingProdFiles) {
      const rel = relOf(f);
      const code = stripComments(readFileSync(f, 'utf8'));
      for (const term of forbidden) {
        if (code.includes(term)) {
          found = true;
          fail('desktop-hosting', `${rel} contains '${term}' — main/hosting/ never touches the child process directly; the SDK owns termination`);
        }
      }
    }
    if (!found) ok();
  }

  // --- shared/hosting/ never names an SDK message variant type, and stays message: unknown ---
  // guard(#98): SDKMessage is a 37-variant open union — the envelope carries
  // `message: unknown` and issue 219/issue 83 own every narrowing decision,
  // one renderer for both. A shared type re-deriving a narrowing here would
  // be a second, competing decision.
  {
    const typesFile = allFiles.find((f) => relOf(f) === `${sharedHostingDir}/types.ts`);
    if (!typesFile) {
      fail('desktop-hosting', `${sharedHostingDir}/types.ts does not exist`);
    } else {
      const text = readFileSync(typesFile, 'utf8');
      if (/\bSDK[A-Za-z]+Message\b/.test(text)) {
        fail('desktop-hosting', `${sharedHostingDir}/types.ts names an SDK message variant type — the envelope must stay opaque (message: unknown)`);
      } else if (!/message:\s*unknown/.test(text)) {
        fail('desktop-hosting', `${sharedHostingDir}/types.ts's event envelope does not carry 'message: unknown'`);
      } else {
        ok();
      }
    }
  }

  // --- All four SDK end-of-process wordings appear in classify.cases.json --
  // guard(#98): a refactor collapsing "exited with code" / "terminated by
  // signal" / "process error" / "aborted by user" into one bucket loses the
  // exact reason an operator needs to see.
  {
    const casesPath = `${hostingDir}/classify.cases.json`;
    const cases = readJson(casesPath) as Array<{ input?: { text?: string } }>;
    const texts = cases.map((c) => c.input?.text ?? '').join('\n');
    const wordings: [string, RegExp][] = [
      ['exited with code', /exited with code/],
      ['terminated by signal', /terminated by signal/],
      ['process error', /process error/],
      ['aborted by user', /aborted by user/],
    ];
    let allPresent = true;
    for (const [name, re] of wordings) {
      if (!re.test(texts)) {
        allPresent = false;
        fail('desktop-hosting', `${casesPath} has no case whose input.text carries the SDK's '${name}' wording`);
      }
    }
    if (allPresent) ok();
  }

  // --- classify.cases.json resolves against classifyEnd's real export ------
  // guard(#98): a case naming a function classify.ts no longer exports,
  // silently skipped rather than failing loudly (the same rail
  // desktop-runtime.ts's own case-table guard already applies).
  // pin: `main/hosting/classify.cases.json` ↔ `classifyEnd` in `main/hosting/classify.ts`
  {
    const classifyFile = allFiles.find((f) => relOf(f) === `${hostingDir}/classify.ts`);
    if (!classifyFile) {
      fail('desktop-hosting', `${hostingDir}/classify.ts does not exist`);
    } else if (!/export function classifyEnd\(/.test(readFileSync(classifyFile, 'utf8'))) {
      fail('desktop-hosting', `${hostingDir}/classify.ts does not export 'classifyEnd'`);
    } else {
      ok();
    }
  }

  // --- SessionPhase's members match the phases handle.ts assigns, both directions ---
  // guard(#98): a phase added to the union with no assignment in handle.ts,
  // or an assignment there naming a phase the union no longer has.
  // pin: `shared/hosting/types.ts`'s `SessionPhase` ↔ `main/hosting/handle.ts`'s own phase assignments, both directions
  {
    const typesFile = allFiles.find((f) => relOf(f) === `${sharedHostingDir}/types.ts`);
    const handleFile = allFiles.find((f) => relOf(f) === `${hostingDir}/handle.ts`);
    if (!typesFile || !handleFile) {
      fail('desktop-hosting', `${sharedHostingDir}/types.ts or ${hostingDir}/handle.ts does not exist`);
    } else {
      const typesText = readFileSync(typesFile, 'utf8');
      const handleText = readFileSync(handleFile, 'utf8');
      const unionMatch = /export type SessionPhase\s*=\s*([^\n]+)/.exec(typesText);
      if (!unionMatch) {
        fail('desktop-hosting', `${sharedHostingDir}/types.ts has no 'export type SessionPhase = ...' declaration`);
      } else {
        const members = new Set([...unionMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
        // Matches both a reassignment (`phase = 'ready'`) and the initial
        // type-annotated declaration (`let phase: SessionPhase = 'starting'`).
        const assigned = new Set([...handleText.matchAll(/\bphase\s*(?::\s*SessionPhase\s*)?=\s*'([^']+)'/g)].map((m) => m[1]));
        for (const member of members) {
          if (!assigned.has(member)) fail('desktop-hosting', `handle.ts never assigns phase = '${member}' — SessionPhase names a phase the handle never reaches`);
        }
        for (const phase of assigned) {
          if (!members.has(phase)) fail('desktop-hosting', `handle.ts assigns phase = '${phase}', which SessionPhase does not name`);
        }
        if (members.size > 0 && [...members].every((m) => assigned.has(m)) && [...assigned].every((p) => members.has(p))) ok();
      }
    }
  }

  // --- No running/alive/isLive identifier or string literal under main/hosting/ ---
  // guard(#98): a hosted session's phase is a real process-phase report
  // (this module owns the child and holds the Query, unlike main/sessions/),
  // but never spells liveness with the words Decision 4 already banned
  // elsewhere in this app.
  {
    const forbidden = ['running', 'alive', 'isLive'];
    let found = false;
    for (const f of hostingProdFiles) {
      const rel = relOf(f);
      const code = stripComments(readFileSync(f, 'utf8'));
      for (const word of forbidden) {
        if (new RegExp(`\\b${word}\\b`).test(code)) {
          found = true;
          fail('desktop-hosting', `${rel} contains '${word}' outside a comment`);
        }
      }
    }
    if (!found) ok();
  }

  // --- main/index.ts's before-quit names the store's closeAll --------------
  // guard(#98): quitting must never orphan a `claude` child, the same rail
  // issue 80 already applies to the board watcher's own timer.
  {
    const indexFile = allFiles.find((f) => relOf(f) === 'apps/desktop/src/main/index.ts');
    if (!indexFile) {
      fail('desktop-hosting', 'apps/desktop/src/main/index.ts does not exist');
    } else {
      const text = readFileSync(indexFile, 'utf8');
      const beforeQuitMatch = /before-quit'\s*,\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\}\s*\)/.exec(text);
      if (!beforeQuitMatch) {
        fail('desktop-hosting', "apps/desktop/src/main/index.ts has no \"app.on('before-quit', () => { ... })\" handler");
      } else if (!/closeAll/.test(beforeQuitMatch[1])) {
        fail('desktop-hosting', "apps/desktop/src/main/index.ts's before-quit handler does not call the hosted store's closeAll()");
      } else {
        ok();
      }
    }
  }

  // --- live.test.ts references PORT_LIVE_SDK and a skip guard --------------
  // guard(#98): the acceptance run must stay opt-in — a missing skip guard
  // would spawn a real `claude` child in every default `pnpm test` run.
  {
    const liveFile = allFiles.find((f) => relOf(f) === `${hostingDir}/live.test.ts`);
    if (!liveFile) {
      fail('desktop-hosting', `${hostingDir}/live.test.ts does not exist`);
    } else {
      const text = readFileSync(liveFile, 'utf8');
      if (!text.includes('PORT_LIVE_SDK')) {
        fail('desktop-hosting', `${hostingDir}/live.test.ts does not reference PORT_LIVE_SDK`);
      } else if (!/skipIf/.test(text)) {
        fail('desktop-hosting', `${hostingDir}/live.test.ts has no 'skipIf' guard — it must stay opt-in`);
      } else {
        ok();
      }
    }
  }

  // --- No permissionPromptToolName under main/hosting/ ----------------------
  // guard(#99): mutually exclusive with canUseTool — the SDK throws when
  // both are present, so this option must never appear here at all.
  {
    let found = false;
    for (const f of hostingProdFiles) {
      const rel = relOf(f);
      const code = stripComments(readFileSync(f, 'utf8'));
      if (code.includes('permissionPromptToolName')) {
        found = true;
        fail('desktop-hosting', `${rel} names 'permissionPromptToolName' — it is mutually exclusive with 'canUseTool' and the SDK throws when both are present`);
      }
    }
    if (!found) ok();
  }

  // --- No bypass/dontAsk escape hatch under main/hosting/ -------------------
  // guard(#99): options.ts must name both canUseTool and permissionMode:
  // 'default' — nothing under main/hosting/ may silently widen past the
  // host prompt this ticket builds.
  {
    const forbidden = ['bypassPermissions', 'allowDangerouslySkipPermissions', "'dontAsk'"];
    let found = false;
    for (const f of hostingProdFiles) {
      const rel = relOf(f);
      const code = stripComments(readFileSync(f, 'utf8'));
      for (const term of forbidden) {
        if (code.includes(term)) {
          found = true;
          fail('desktop-hosting', `${rel} contains '${term}' — main/hosting/ must never bypass the operator's own permission prompt`);
        }
      }
    }
    const optionsFile = allFiles.find((f) => relOf(f) === `${hostingDir}/options.ts`);
    if (!optionsFile) {
      found = true;
      fail('desktop-hosting', `${hostingDir}/options.ts does not exist`);
    } else {
      const text = readFileSync(optionsFile, 'utf8');
      if (!/canUseTool/.test(text)) {
        found = true;
        fail('desktop-hosting', `${hostingDir}/options.ts does not name 'canUseTool'`);
      }
      if (!/permissionMode:\s*'default'/.test(text)) {
        found = true;
        fail('desktop-hosting', `${hostingDir}/options.ts does not set permissionMode: 'default'`);
      }
    }
    if (!found) ok();
  }

  // --- Every destination: in grant.ts is 'session' --------------------------
  // guard(#99): an "allow for this session" must never write a settings
  // file — a widened destination here would be unrecoverable from inside
  // the app.
  {
    const grantFile = allFiles.find((f) => relOf(f) === `${hostingDir}/grant.ts`);
    if (!grantFile) {
      fail('desktop-hosting', `${hostingDir}/grant.ts does not exist`);
    } else {
      const text = stripComments(readFileSync(grantFile, 'utf8'));
      const destinations = [...text.matchAll(/destination:\s*'([^']+)'/g)].map((m) => m[1]);
      const stray = destinations.filter((d) => d !== 'session');
      if (destinations.length === 0) {
        fail('desktop-hosting', `${hostingDir}/grant.ts names no 'destination:' literal at all`);
      } else if (stray.length > 0) {
        fail('desktop-hosting', `${hostingDir}/grant.ts names a 'destination:' other than 'session': ${stray.join(', ')}`);
      } else {
        ok();
      }
    }
  }

  // --- permissions.ts's canUseTool returns Promise<PermissionResult>, no | null ---
  // guard(#99): the SDK's own CanUseTool returns `Promise<PermissionResult |
  // null>`, treating `null` as "already answered out of band" and leaving
  // the tool blocked forever. This broker never answers out of band, so its
  // own declared type excludes `null` — a compile error catches a future
  // edit that reintroduces it.
  {
    const permissionsFile = allFiles.find((f) => relOf(f) === `${hostingDir}/permissions.ts`);
    if (!permissionsFile) {
      fail('desktop-hosting', `${hostingDir}/permissions.ts does not exist`);
    } else {
      const text = readFileSync(permissionsFile, 'utf8');
      if (!/readonly canUseTool:\s*CanUseTool/.test(text)) {
        fail('desktop-hosting', `${hostingDir}/permissions.ts's PermissionBroker does not declare 'canUseTool: CanUseTool'`);
      } else if (/Promise<PermissionResult\s*\|\s*null>/.test(text)) {
        fail('desktop-hosting', `${hostingDir}/permissions.ts's canUseTool is typed to allow '| null' — this broker must never answer out of band`);
      } else {
        ok();
      }
    }
  }

  // --- project.ts's live projection goes through createDeriver ------------
  // guard(#219): the live projector must reuse issue 83/issue 84's own
  // pairing state, never a second implementation — the whole point of "one
  // normalizer, one renderer" (the plan's own framing, and the fix for the
  // issue 123 three-renderers trap).
  {
    const projectFile = allFiles.find((f) => relOf(f) === `${hostingDir}/project.ts`);
    if (!projectFile) {
      fail('desktop-hosting', `${hostingDir}/project.ts does not exist`);
    } else {
      const text = readFileSync(projectFile, 'utf8');
      if (!/createDeriver/.test(text) || !/from\s+['"]\.\.\/sessions['"]/.test(text)) {
        fail('desktop-hosting', `${hostingDir}/project.ts does not import 'createDeriver' from '../sessions'`);
      } else {
        ok();
      }
    }
  }

  // --- No second tool_use_id pairing implementation -----------------------
  // guard(#219): `\btool_use_id\b` may appear in exactly one production file
  // — `main/sessions/transcript-entries.ts`'s own deriver. A second match
  // anywhere else under apps/desktop/src/ (project.ts included) would be a
  // competing pairing implementation, the same trap the createDeriver guard
  // above exists to prevent from the other direction.
  {
    const allowedFile = 'apps/desktop/src/main/sessions/transcript-entries.ts';
    const prodFiles = allFiles.filter((f) => !relOf(f).endsWith('.test.ts'));
    const stray = prodFiles.filter((f) => relOf(f) !== allowedFile).filter((f) => /\btool_use_id\b/.test(readFileSync(f, 'utf8')));
    if (stray.length > 0) {
      fail('desktop-hosting', `'tool_use_id' appears outside ${allowedFile}, in: ${stray.map(relOf).join(', ')} — a second pairing implementation is the three-renderers trap #123 flagged`);
    } else {
      ok();
    }
  }

  // --- options.ts sets settingSources to exactly the three explicit sources ---
  // guard(#101): an omitted or empty settingSources silently drops the
  // repository's own permissions.deny, its enabledPlugins (so no installed
  // port), and CLAUDE.md — this must never regress to the SDK's own
  // unstated default.
  {
    const optionsFile = allFiles.find((f) => relOf(f) === `${hostingDir}/options.ts`);
    if (!optionsFile) {
      fail('desktop-hosting', `${hostingDir}/options.ts does not exist`);
    } else {
      const text = stripComments(readFileSync(optionsFile, 'utf8'));
      if (!/SETTING_SOURCES[^=]*=\s*\[\s*'user'\s*,\s*'project'\s*,\s*'local'\s*\]/.test(text)) {
        fail('desktop-hosting', `${hostingDir}/options.ts does not assign settingSources to exactly ['user', 'project', 'local']`);
      } else if (!/settingSources/.test(text)) {
        fail('desktop-hosting', `${hostingDir}/options.ts declares SETTING_SOURCES but never assigns it to 'settingSources'`);
      } else {
        ok();
      }
    }
  }

  // --- No production file under main/hosting/ passes a skills: option key ---
  // guard(#101): a command runs as a typed slash command in the live
  // session, never through the Skill-tool filter — `skills` only hides
  // every unlisted skill and cannot target an already-running session, so
  // this option key must never appear here at all. `ExpectedComponents`'s
  // own `readonly skills: readonly string[]` field (plugin.ts/verify.ts) is
  // an unrelated shape naming the same word — excluded by requiring the
  // match not be a `readonly skills:` type declaration.
  {
    let found = false;
    for (const f of hostingProdFiles) {
      const rel = relOf(f);
      const code = stripComments(readFileSync(f, 'utf8'));
      for (const line of code.split('\n')) {
        if (/\bskills\s*:/.test(line) && !/readonly\s+skills\s*:/.test(line)) {
          found = true;
          fail('desktop-hosting', `${rel} passes a 'skills:' option key — commands must run as typed slash commands, never through the Skill-tool filter`);
        }
      }
    }
    if (!found) ok();
  }

  // --- capabilities.ts reads both supportedCommands() and supportedAgents() ---
  // guard(#101): the inventory is read back, never assumed — a plugin flag
  // silently doing nothing must surface as 'missing'/'unavailable', not an
  // empty command strip nobody investigates.
  {
    const capabilitiesFile = allFiles.find((f) => relOf(f) === `${hostingDir}/capabilities.ts`);
    if (!capabilitiesFile) {
      fail('desktop-hosting', `${hostingDir}/capabilities.ts does not exist`);
    } else {
      const text = readFileSync(capabilitiesFile, 'utf8');
      if (!/supportedCommands\(/.test(text) || !/supportedAgents\(/.test(text)) {
        fail('desktop-hosting', `${hostingDir}/capabilities.ts does not call both supportedCommands() and supportedAgents()`);
      } else {
        ok();
      }
    }
  }
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}
