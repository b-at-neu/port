import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, readJson, walk, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';
import { globToRegExp as hookGlobToRegExp } from '../../plugins/port/hooks/lib/guard-rules.mjs';

// apps/desktop/src/main/hosting/ owns the full lifecycle of a hosted session in the main
// process. These assertions pin its plan's decisions mechanically.
export default async function ({ expect, fail, ok }: Reporter) {
  const hostingDir = 'apps/desktop/src/main/hosting';
  const sharedHostingDir = 'apps/desktop/src/shared/hosting';
  const srcDir = join(root, 'apps/desktop/src');
  const allFiles = walk(srcDir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
  const hostingFiles = allFiles.filter((f) => relOf(f).startsWith(`${hostingDir}/`));
  const hostingProdFiles = hostingFiles.filter((f) => !relOf(f).endsWith('.test.ts'));
  const sharedHostingFiles = allFiles.filter((f) => relOf(f).startsWith(`${sharedHostingDir}/`));
  const sharedHostingProdFiles = sharedHostingFiles.filter((f) => !relOf(f).endsWith('.test.ts'));

  // --- No string prompt anywhere under main/hosting/ — streaming input mode, always, since
  // `interrupt()`/`setPermissionMode()` need it or Stop becomes impossible. ---
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

  // --- No direct process control under main/hosting/ — the SDK owns termination, never
  // `process.kill` or a raw node:child_process/node:fs reach-around. ---
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

  // --- shared/hosting/ never names an SDK message variant type, and stays message: unknown
  // — SDKMessage is a large open union, and a shared type re-deriving a narrowing here would compete with the one true renderer. ---
  {
    const typesFile = allFiles.find((f) => relOf(f) === `${sharedHostingDir}/types.ts`);
    if (!typesFile) {
      fail('desktop-hosting', `${sharedHostingDir}/types.ts does not exist`);
    } else {
      const text = readFileSync(typesFile, 'utf8');
      if (/\bSDK[A-Za-z]+Message\b/.test(text)) {
        fail('desktop-hosting', `${sharedHostingDir}/types.ts names an SDK message variant type — the envelope must stay opaque (message: unknown)`);
      } else expect(/message:\s*unknown/.test(text), 'desktop-hosting', `${sharedHostingDir}/types.ts's event envelope does not carry 'message: unknown'`);
    }
  }

  // --- All four SDK end-of-process wordings appear in classify.cases.json — collapsing them
  // into one bucket loses the exact reason an operator needs to see. ---
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

  // pin: `main/hosting/classify.cases.json` ↔ `classifyEnd` in `main/hosting/classify.ts`
  {
    const classifyFile = allFiles.find((f) => relOf(f) === `${hostingDir}/classify.ts`);
    if (!classifyFile) {
      fail('desktop-hosting', `${hostingDir}/classify.ts does not exist`);
    } else expect(/export function classifyEnd\(/.test(readFileSync(classifyFile, 'utf8')), 'desktop-hosting', `${hostingDir}/classify.ts does not export 'classifyEnd'`);
  }

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
        // Matches both a reassignment and the initial type-annotated declaration.
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

  // --- No running/alive/isLive identifier under main/hosting/ — a hosted session's phase is
  // a real process-phase report, but must never spell liveness with those words. ---
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

  // --- main/index.ts's before-quit names the store's closeAll — quitting must never orphan a `claude` child. ---
  {
    const indexFile = allFiles.find((f) => relOf(f) === 'apps/desktop/src/main/index.ts');
    if (!indexFile) {
      fail('desktop-hosting', 'apps/desktop/src/main/index.ts does not exist');
    } else {
      const text = readFileSync(indexFile, 'utf8');
      const beforeQuitMatch = /before-quit'\s*,\s*\(\s*\w*\s*\)\s*=>\s*\{([\s\S]*?)\n\s*\}\s*\)/.exec(text);
      if (!beforeQuitMatch) {
        fail('desktop-hosting', "apps/desktop/src/main/index.ts has no \"app.on('before-quit', (...) => { ... })\" handler");
      } else expect(/closeAll/.test(beforeQuitMatch[1]), 'desktop-hosting', "apps/desktop/src/main/index.ts's before-quit handler does not call the hosted store's closeAll()");
    }
  }

  // --- live.test.ts references PORT_LIVE_SDK and a skip guard — the acceptance run must
  // stay opt-in, or it spawns a real `claude` child in every default test run. ---
  {
    const liveFile = allFiles.find((f) => relOf(f) === `${hostingDir}/live.test.ts`);
    if (!liveFile) {
      fail('desktop-hosting', `${hostingDir}/live.test.ts does not exist`);
    } else {
      const text = readFileSync(liveFile, 'utf8');
      if (!text.includes('PORT_LIVE_SDK')) {
        fail('desktop-hosting', `${hostingDir}/live.test.ts does not reference PORT_LIVE_SDK`);
      } else expect(/skipIf/.test(text), 'desktop-hosting', `${hostingDir}/live.test.ts has no 'skipIf' guard — it must stay opt-in`);
    }
  }

  // --- No permissionPromptToolName under main/hosting/ — mutually exclusive with
  // canUseTool; the SDK throws when both are present. ---
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

  // --- No bypass/dontAsk escape hatch under main/hosting/ or shared/hosting/ ---
  // guard: nothing under either tree may silently widen past the host prompt.
  {
    const forbidden = ['bypassPermissions', 'allowDangerouslySkipPermissions', "'dontAsk'"];
    let found = false;
    for (const f of [...hostingProdFiles, ...sharedHostingProdFiles]) {
      const rel = relOf(f);
      const code = stripComments(readFileSync(f, 'utf8'));
      for (const term of forbidden) {
        if (code.includes(term)) {
          found = true;
          fail('desktop-hosting', `${rel} contains '${term}' — main/hosting/ and shared/hosting/ must never bypass the operator's own permission prompt`);
        }
      }
    }
    const optionsFile = allFiles.find((f) => relOf(f) === `${hostingDir}/options.ts`);
    if (!optionsFile) {
      found = true;
      fail('desktop-hosting', `${hostingDir}/options.ts does not exist`);
    } else if (!/canUseTool/.test(readFileSync(optionsFile, 'utf8'))) {
      found = true;
      fail('desktop-hosting', `${hostingDir}/options.ts does not name 'canUseTool'`);
    }
    if (!found) ok();
  }

  // --- Every destination: in grant.ts is 'session' — never a settings file, which would be unrecoverable from inside the app. ---
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
      } else expect(!(stray.length > 0), 'desktop-hosting', `${hostingDir}/grant.ts names a 'destination:' other than 'session': ${stray.join(', ')}`);
    }
  }

  // --- permissions.ts's canUseTool returns Promise<PermissionResult>, no | null — this
  // broker never answers out of band, so its declared type excludes `null`. ---
  {
    const permissionsFile = allFiles.find((f) => relOf(f) === `${hostingDir}/permissions.ts`);
    if (!permissionsFile) {
      fail('desktop-hosting', `${hostingDir}/permissions.ts does not exist`);
    } else {
      const text = readFileSync(permissionsFile, 'utf8');
      if (!/readonly canUseTool:\s*CanUseTool/.test(text)) {
        fail('desktop-hosting', `${hostingDir}/permissions.ts's PermissionBroker does not declare 'canUseTool: CanUseTool'`);
      } else expect(!/Promise<PermissionResult\s*\|\s*null>/.test(text), 'desktop-hosting', `${hostingDir}/permissions.ts's canUseTool is typed to allow '| null' — this broker must never answer out of band`);
    }
  }

  // --- project.ts's live projection goes through createDeriver — reuses the existing pairing
  // state, never a second implementation. ---
  {
    const projectFile = allFiles.find((f) => relOf(f) === `${hostingDir}/project.ts`);
    if (!projectFile) {
      fail('desktop-hosting', `${hostingDir}/project.ts does not exist`);
    } else {
      const text = readFileSync(projectFile, 'utf8');
      expect(!(!/createDeriver/.test(text) || !/from\s+['"]\.\.\/sessions\/transcript-entries['"]/.test(text)), 'desktop-hosting', `${hostingDir}/project.ts does not import 'createDeriver' from '../sessions/transcript-entries'`);
    }
  }

  // --- No second tool_use_id pairing implementation — the literal may appear only in
  // transcript-entries.ts's own deriver; a second match anywhere else is a competing implementation. ---
  {
    const allowedFile = 'apps/desktop/src/main/sessions/transcript-entries.ts';
    const prodFiles = allFiles.filter((f) => !relOf(f).endsWith('.test.ts'));
    const stray = prodFiles.filter((f) => relOf(f) !== allowedFile).filter((f) => /\btool_use_id\b/.test(readFileSync(f, 'utf8')));
    expect(!(stray.length > 0), 'desktop-hosting', `'tool_use_id' appears outside ${allowedFile}, in: ${stray.map(relOf).join(', ')} — a second pairing implementation is the three-renderers trap #123 flagged`);
  }

  // --- options.ts sets settingSources to exactly the three explicit sources — an omitted or
  // empty one silently drops permissions.deny, enabledPlugins, and CLAUDE.md. ---
  {
    const optionsFile = allFiles.find((f) => relOf(f) === `${hostingDir}/options.ts`);
    if (!optionsFile) {
      fail('desktop-hosting', `${hostingDir}/options.ts does not exist`);
    } else {
      const text = stripComments(readFileSync(optionsFile, 'utf8'));
      if (!/SETTING_SOURCES[^=]*=\s*\[\s*'user'\s*,\s*'project'\s*,\s*'local'\s*\]/.test(text)) {
        fail('desktop-hosting', `${hostingDir}/options.ts does not assign settingSources to exactly ['user', 'project', 'local']`);
      } else expect(/settingSources/.test(text), 'desktop-hosting', `${hostingDir}/options.ts declares SETTING_SOURCES but never assigns it to 'settingSources'`);
    }
  }

  // --- No production file under main/hosting/ passes a skills: option key — a command runs
  // as a typed slash command, never through the Skill-tool filter. Excludes the unrelated `readonly skills:` type declaration. ---
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

  // --- No production file under main/hosting/ names a tools: option key — it restricts the
  // whole session's built-in set, including subagents, stripping `Bash`/`Write` from a stage session. ---
  {
    let found = false;
    for (const f of hostingProdFiles) {
      const rel = relOf(f);
      const code = stripComments(readFileSync(f, 'utf8'));
      for (const line of code.split('\n')) {
        if (/(?:^|[^A-Za-z0-9_])tools\s*:/.test(line)) {
          found = true;
          fail('desktop-hosting', `${rel} passes a 'tools:' option key — this restricts the whole session's built-in set, including subagents; use 'allowedTools:' instead`);
        }
      }
    }
    if (!found) ok();
  }

  // --- capabilities.ts reads both supportedCommands() and supportedAgents() — the inventory
  // is read back, never assumed, so a plugin flag doing nothing surfaces as unavailable. ---
  {
    const capabilitiesFile = allFiles.find((f) => relOf(f) === `${hostingDir}/capabilities.ts`);
    if (!capabilitiesFile) {
      fail('desktop-hosting', `${hostingDir}/capabilities.ts does not exist`);
    } else {
      const text = readFileSync(capabilitiesFile, 'utf8');
      expect(!(!/supportedCommands\(/.test(text) || !/supportedAgents\(/.test(text)), 'desktop-hosting', `${hostingDir}/capabilities.ts does not call both supportedCommands() and supportedAgents()`);
    }
  }

  // --- Only persist.ts names writeJsonFileAtomic or hosting.json under main/hosting/ — a
  // second writer could persist a set that skipped freeze() on quit. ---
  {
    const stray = hostingProdFiles.filter((f) => relOf(f) !== `${hostingDir}/persist.ts`).filter((f) => {
      const code = stripComments(readFileSync(f, 'utf8'));
      return code.includes('writeJsonFileAtomic') || code.includes('hosting.json');
    });
    expect(!(stray.length > 0), 'desktop-hosting', `writeJsonFileAtomic or 'hosting.json' appears outside ${hostingDir}/persist.ts, in: ${stray.map(relOf).join(', ')} — a second writer could skip freeze() on quit`);
  }

  // pin: shared/hosting/label.ts's sessionDisplayLabel ↔ its two consumers — if the dialog
  // and the rail named a session differently, the operator could not tell which prompt belongs where.
  {
    const declarations = allFiles.filter((f) => !relOf(f).endsWith('.test.ts')).filter((f) => /export function sessionDisplayLabel\(/.test(readFileSync(f, 'utf8')));
    const declaredOnlyInLabel = declarations.length === 1 && relOf(declarations[0] ?? '') === `${sharedHostingDir}/label.ts`;
    const headerFile = allFiles.find((f) => relOf(f) === 'apps/desktop/src/renderer/src/session/header.tsx');
    const dialogFile = allFiles.find((f) => relOf(f) === 'apps/desktop/src/renderer/src/permission/dialog.tsx');
    const copyFile = allFiles.find((f) => relOf(f) === 'apps/desktop/src/renderer/src/permission/copy.ts');
    if (!declaredOnlyInLabel) {
      fail('desktop-hosting', `sessionDisplayLabel must be declared only in ${sharedHostingDir}/label.ts, found in: ${declarations.map(relOf).join(', ') || '(nowhere)'}`);
    } else if (!headerFile || !/sessionDisplayLabel/.test(readFileSync(headerFile, 'utf8'))) {
      fail('desktop-hosting', 'apps/desktop/src/renderer/src/session/header.tsx does not import sessionDisplayLabel');
    } else if (!dialogFile || !/sessionDisplayLabel/.test(readFileSync(dialogFile, 'utf8'))) {
      fail('desktop-hosting', 'apps/desktop/src/renderer/src/permission/dialog.tsx does not import sessionDisplayLabel');
    } else expect(!(!copyFile || /function contextLine\([^)]*sessionKey/.test(readFileSync(copyFile, 'utf8'))), 'desktop-hosting', "apps/desktop/src/renderer/src/permission/copy.ts's contextLine must take no 'sessionKey' parameter");
  }

  // --- stage-policy.ts's own globToRegExp agrees with guard-rules.mjs's over a shared case list, both directions. ---
  {
    const stagePolicyFile = allFiles.find((f) => relOf(f) === `${hostingDir}/stage-policy.ts`);
    if (!stagePolicyFile) {
      fail('desktop-hosting', `${hostingDir}/stage-policy.ts does not exist`);
    } else {
      const module = (await import(pathToFileURL(stagePolicyFile).href)) as { readonly globToRegExp?: (glob: string) => RegExp };
      if (typeof module.globToRegExp !== 'function') {
        fail('desktop-hosting', `${hostingDir}/stage-policy.ts does not export 'globToRegExp'`);
      } else {
        const appGlobToRegExp = module.globToRegExp;
        const cases: readonly { readonly glob: string; readonly path: string; readonly matches: boolean }[] = [
          { glob: 'CLAUDE.md', path: 'CLAUDE.md', matches: true },
          { glob: 'CLAUDE.md', path: 'src/CLAUDE.md', matches: false },
          { glob: '.claude/**', path: '.claude/settings.json', matches: true },
          { glob: '.claude/**', path: '.claude/sub/dir/file.json', matches: true },
          { glob: '.claude/**', path: '.claudexyz', matches: false },
          { glob: 'src/*.ts', path: 'src/index.ts', matches: true },
          { glob: 'src/*.ts', path: 'src/sub/index.ts', matches: false },
          { glob: 'infra/**', path: 'infra', matches: false },
        ];
        let allAgree = true;
        for (const { glob, path, matches } of cases) {
          const hook = hookGlobToRegExp(glob).test(path);
          const app = appGlobToRegExp(glob).test(path);
          if (hook !== matches || app !== matches) {
            allAgree = false;
            fail('desktop-hosting', `globToRegExp parity: glob ${glob} against ${path} — guard-rules.mjs says ${String(hook)}, stage-policy.ts says ${String(app)}, expected ${String(matches)}`);
          }
        }
        if (allAgree) ok();
      }
    }
  }

  // --- The stage branch under options.ts names permissionMode: 'default' and never dontAsk/bypassPermissions; no file under main/stage/ names systemPrompt. ---
  {
    const optionsFile = allFiles.find((f) => relOf(f) === `${hostingDir}/options.ts`);
    if (!optionsFile) {
      fail('desktop-hosting', `${hostingDir}/options.ts does not exist`);
    } else {
      const text = stripComments(readFileSync(optionsFile, 'utf8'));
      if (!/permissionMode:\s*params\.stage\s*!==\s*null\s*\?\s*'default'/.test(text)) {
        fail('desktop-hosting', `${hostingDir}/options.ts's stage branch does not name permissionMode: 'default'`);
      } else if (/dontAsk|bypassPermissions/.test(text)) {
        fail('desktop-hosting', `${hostingDir}/options.ts names a dontAsk/bypassPermissions escape hatch`);
      } else ok();
    }

    const stageDir = 'apps/desktop/src/main/stage';
    const stageFiles = allFiles.filter((f) => relOf(f).startsWith(`${stageDir}/`) && !relOf(f).endsWith('.test.ts'));
    const systemPromptStray = stageFiles.filter((f) => /systemPrompt/.test(stripComments(readFileSync(f, 'utf8'))));
    expect(!(systemPromptStray.length > 0), 'desktop-hosting', `main/stage/ names 'systemPrompt': ${systemPromptStray.map(relOf).join(', ')} — the agent file's own system prompt is the only instruction source`);
  }
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}
