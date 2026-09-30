import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, readJson } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';
import { extractJobBlock } from './portability.ts';

/** Resolves the checked-out branch name from files alone — no `git`
 *  subprocess, so this stays usable from a layer 1 check that must not
 *  shell out. `null` for a detached `HEAD` (every CI `pull_request` run
 *  checks out the merge ref, never a branch). */
function currentBranch(repoRoot: string): string | null {
  const gitPath = join(repoRoot, '.git');
  let headFile;
  if (statSync(gitPath).isDirectory()) {
    headFile = join(gitPath, 'HEAD');
  } else {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitPath, 'utf8').trim());
    if (!m) return null;
    headFile = join(repoRoot, m[1], 'HEAD');
  }
  if (!existsSync(headFile)) return null;
  const m = /^ref:\s*refs\/heads\/(.+)$/.exec(readFileSync(headFile, 'utf8').trim());
  return m ? m[1] : null;
}

/** The top-level `on:` block's direct child keys (e.g. `['pull_request']`),
 *  or `null` when there is no `on:` block at all. Per-job-block reasoning
 *  (docs/ENGINEERING.md §7 — a check must distinguish the state it exists to
 *  detect): a whole-file substring search for `push:` would also match a
 *  step named "push", so this reads only the direct children of the
 *  top-level `on:` mapping. Handles both the block form every workflow in
 *  this repository uses (`on:\n  push:\n  pull_request:`) and the inline
 *  scalar/list forms (`on: push`, `on: [push, pull_request]`) for
 *  completeness, since nothing pins which form a hand-edit introduces. */
export function onTriggers(text: string): string[] | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const startIdx = lines.findIndex((l) => /^on:/.test(l));
  if (startIdx === -1) return null;

  const inline = /^on:\s*(\S.*)$/.exec(lines[startIdx]);
  if (inline) {
    const value = inline[1].trim();
    const list = /^\[(.*)\]$/.exec(value);
    if (list) return list[1].split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    return [value];
  }

  const keys: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (/^\S/.test(line)) break; // back to top-level indentation — on: block ended
    const m = /^  ([A-Za-z0-9_-]+):/.exec(line);
    if (m) keys.push(m[1]);
  }
  return keys;
}

export default async function ({ fail, note, ok }: Reporter) {
  const { classifyCorridor, releaseInFlight } = await import(pathToFileURL(join(root, 'scripts/release-corridor.ts')).href);
  const { parseVersion, nextDevWindow, decide } = await import(pathToFileURL(join(root, 'scripts/dev-window.ts')).href);

  // --- Integration branch stays on a prerelease version (#224) ---------------
  // guard(#224): a dev-loop install and a released consumer install both
  // resolving to the same versioned plugin cache directory, so developing
  // port silently overwrites what other repositories run.
  // guard(#275): layer 1 cannot see GitHub, so it must never guess "no
  // release in flight" for a clean integration branch — every release
  // merge used to fail this check at exactly the moment nothing was wrong.
  {
    const cfg = readJson('.claude/port.config.json');
    const production = cfg.branches?.production;
    if (production === null) {
      note('release: single-branch mode (branches.production is null) — no release corridor to check');
    } else {
      const productionName = production ?? 'main';
      const integrationName = cfg.branches?.integration ?? 'dev';
      const manifestRel = (cfg.release?.versionFiles ?? [])[0] ?? 'plugins/port/.claude-plugin/plugin.json';

      // Self-test first (ENGINEERING §7): every row of classifyCorridor's
      // verdict table, plus two message-content cases, before trusting the
      // predicate against real files.
      const cases: { name: string; args: Parameters<typeof classifyCorridor>[0]; want: string }[] = [
        { name: 'production, clean', args: { branch: 'main', productionName: 'main', integrationName: 'dev', version: '0.3.0', hasSuffix: false, inFlight: { checked: false } }, want: 'pass' },
        { name: 'production, suffixed', args: { branch: 'main', productionName: 'main', integrationName: 'dev', version: '0.3.0-dev', hasSuffix: true, inFlight: { checked: false } }, want: 'violation' },
        { name: 'integration, suffixed', args: { branch: 'dev', productionName: 'main', integrationName: 'dev', version: '0.3.1-dev', hasSuffix: true, inFlight: { checked: false } }, want: 'pass' },
        { name: 'integration, clean, not checked', args: { branch: 'dev', productionName: 'main', integrationName: 'dev', version: '0.3.0', hasSuffix: false, inFlight: { checked: false } }, want: 'unresolved' },
        {
          name: 'integration, clean, a reason',
          args: { branch: 'dev', productionName: 'main', integrationName: 'dev', version: '0.3.0', hasSuffix: false, inFlight: { checked: true, reason: "release pull request #273 ('Release v0.3.0') is open", shipped: false, hookCommand: null } },
          want: 'in-flight',
        },
        {
          name: 'integration, clean, no reason',
          args: { branch: 'dev', productionName: 'main', integrationName: 'dev', version: '0.3.0', hasSuffix: false, inFlight: { checked: true, reason: null, shipped: false, hookCommand: null } },
          want: 'violation',
        },
        { name: 'feature branch, clean — skip', args: { branch: '275-ticket', productionName: 'main', integrationName: 'dev', version: '0.3.0', hasSuffix: false, inFlight: { checked: false } }, want: 'skip' },
        { name: 'detached, suffixed — skip', args: { branch: null, productionName: 'main', integrationName: 'dev', version: '0.3.0-dev', hasSuffix: true, inFlight: { checked: false } }, want: 'skip' },
      ];
      for (const c of cases) {
        const got = classifyCorridor(c.args).verdict;
        if (got !== c.want) fail('release-corridor', `classifyCorridor self-test '${c.name}': expected verdict='${c.want}', got='${got}'`);
        else ok();
      }

      const shippedFix = classifyCorridor({
        branch: 'dev', productionName: 'main', integrationName: 'dev', version: '0.3.0', hasSuffix: false,
        inFlight: { checked: true, reason: null, shipped: true, hookCommand: 'node scripts/dev-window.ts' },
      });
      if (!shippedFix.message.includes('release.postPublishHook') || !shippedFix.message.includes('node scripts/dev-window.ts')) {
        fail('release-corridor', "classifyCorridor self-test 'shipped fix': message must name release.postPublishHook and its configured command");
      } else {
        ok();
      }
      const unshippedFix = classifyCorridor({
        branch: 'dev', productionName: 'main', integrationName: 'dev', version: '0.3.0', hasSuffix: false,
        inFlight: { checked: true, reason: null, shipped: false, hookCommand: null },
      });
      if (!unshippedFix.message.includes('/port:release')) {
        fail('release-corridor', "classifyCorridor self-test 'unshipped fix': message must name /port:release");
      } else {
        ok();
      }

      // releaseInFlight self-test: a passing example of each kind of
      // evidence it reads.
      const inFlightCases: { name: string; args: Parameters<typeof releaseInFlight>[0]; wantReason: string | null; wantShipped: boolean }[] = [
        {
          name: 'matching title',
          args: { version: '0.3.0', releasePrs: [{ number: 273, title: 'Release v0.3.0' }], productionName: 'main', productionVersion: '0.2.0', publishedTags: [], devWindowPrs: [], devWindowBranch: '' },
          wantReason: "release pull request #273 ('Release v0.3.0') is open",
          wantShipped: false,
        },
        {
          name: 'mismatched title',
          args: { version: '0.3.0', releasePrs: [{ number: 273, title: 'Release v0.2.9' }], productionName: 'main', productionVersion: '0.2.0', publishedTags: [], devWindowPrs: [], devWindowBranch: '' },
          wantReason: null,
          wantShipped: false,
        },
        {
          name: 'unparseable title',
          args: { version: '0.3.0', releasePrs: [{ number: 273, title: 'chore: release' }], productionName: 'main', productionVersion: '0.2.0', publishedTags: [], devWindowPrs: [], devWindowBranch: '' },
          wantReason: 'release pull request #273 is open (title unparseable — adopting v0.3.0, as /port:release does)',
          wantShipped: false,
        },
        {
          name: 'merged-unpublished',
          args: { version: '0.3.0', releasePrs: [], productionName: 'main', productionVersion: '0.3.0', publishedTags: [], devWindowPrs: [], devWindowBranch: '' },
          wantReason: 'v0.3.0 merged into main, not yet published',
          wantShipped: false,
        },
        {
          name: 'published, no dev-window PR',
          args: { version: '0.3.0', releasePrs: [], productionName: 'main', productionVersion: '0.2.0', publishedTags: [{ tagName: 'v0.3.0', isDraft: false }], devWindowPrs: [], devWindowBranch: '' },
          wantReason: null,
          wantShipped: true,
        },
        {
          name: 'dev-window PR open',
          args: { version: '0.3.0', releasePrs: [], productionName: 'main', productionVersion: '0.2.0', publishedTags: [{ tagName: 'v0.3.0', isDraft: false }], devWindowPrs: [{ number: 277 }], devWindowBranch: 'devwindow/v0.3.1-dev' },
          wantReason: 'dev-window pull request #277 (devwindow/v0.3.1-dev) is open',
          wantShipped: true,
        },
      ];
      for (const c of inFlightCases) {
        const got = releaseInFlight(c.args);
        if (got.reason !== c.wantReason || got.shipped !== c.wantShipped) {
          fail('release-corridor', `releaseInFlight self-test '${c.name}': expected reason=${JSON.stringify(c.wantReason)} shipped=${c.wantShipped}, got reason=${JSON.stringify(got.reason)} shipped=${got.shipped}`);
        } else {
          ok();
        }
      }

      const manifest = readJson(manifestRel);
      const parsed = parseVersion(manifest.version);
      if (!parsed) {
        fail('release-corridor', `${manifestRel}'s version '${manifest.version}' is not well-formed semver`);
      } else {
        ok();
        const branch = currentBranch(root);
        // Real evaluation always passes inFlight: { checked: false } — layer
        // 1 never calls gh, so this can only ever report the production arm
        // as a violation; a clean integration branch reports `unresolved`.
        const result = classifyCorridor({
          branch,
          productionName,
          integrationName,
          version: manifest.version,
          hasSuffix: Boolean(parsed.suffix),
          inFlight: { checked: false },
        });
        if (result.verdict === 'violation') {
          fail('release-corridor', `${result.message} — fix: merge the open devwindow/v<next> pull request (or the release corridor fix), never hand-edit ${manifestRel}`);
        } else if (result.verdict === 'unresolved') {
          note(result.message);
          ok();
        } else if (result.verdict === 'skip' && !parsed.suffix) {
          // Skip arm, but a note when the version reads clean rather than
          // silence — silence must never be read as a pass.
          note(`release: ${branch === null ? 'detached HEAD' : `branch '${branch}'`} carries a clean version '${manifest.version}' (release corridor not checked here)`);
          ok();
        } else {
          ok();
        }
      }
    }
  }

  // --- One authoritative result per check name and commit (#275) -----------
  // guard(#275): the push trigger coming back to checks.yml, whose run lands
  // on the open release pull request's own head SHA under the same
  // run-static-checks (<os>) names its pull_request-triggered run already
  // produced for the same commit.
  {
    // Self-test onTriggers first, in both directions.
    const syntheticBlock = ['on:', '  push:', '  pull_request:', 'permissions:', '  contents: read'].join('\n');
    const syntheticInline = 'on: push\npermissions:\n  contents: read';
    const syntheticNone = 'name: X\npermissions:\n  contents: read';
    if (JSON.stringify(onTriggers(syntheticBlock)) !== JSON.stringify(['push', 'pull_request'])) {
      fail('release-corridor-triggers', 'onTriggers self-test: block form must return its direct child keys in order');
    } else {
      ok();
    }
    if (JSON.stringify(onTriggers(syntheticInline)) !== JSON.stringify(['push'])) {
      fail('release-corridor-triggers', 'onTriggers self-test: inline scalar form must return a one-element array');
    } else {
      ok();
    }
    if (onTriggers(syntheticNone) !== null) {
      fail('release-corridor-triggers', 'onTriggers self-test: a file with no on: block must return null');
    } else {
      ok();
    }

    const checksRel = '.github/workflows/checks.yml';
    const corridorRel = '.github/workflows/release-corridor.yml';
    const checksText = readFileSync(join(root, checksRel), 'utf8');
    const corridorText = readFileSync(join(root, corridorRel), 'utf8');

    const checksTriggers = onTriggers(checksText);
    if (JSON.stringify(checksTriggers) !== JSON.stringify(['pull_request'])) {
      fail('release-corridor-triggers', `${checksRel}: on: must be exactly ['pull_request'], got ${JSON.stringify(checksTriggers)} — a push trigger recreates the two-readers-of-the-same-commit race #275 removed`);
    } else {
      ok();
    }

    const corridorTriggers = onTriggers(corridorText);
    if (JSON.stringify(corridorTriggers) !== JSON.stringify(['push'])) {
      fail('release-corridor-triggers', `${corridorRel}: on: must be exactly ['push'], got ${JSON.stringify(corridorTriggers)} — adding pull_request or workflow_dispatch would put a second run-release-corridor result on the release pull request's own head SHA`);
    } else {
      ok();
    }

    // pin: release-corridor.yml's push branches ↔ .claude/port.config.json branches
    const cfg2 = readJson('.claude/port.config.json');
    if (cfg2.branches?.production !== null) {
      const wantBranches = [cfg2.branches?.integration ?? 'dev', cfg2.branches?.production ?? 'main'];
      const m = /on:\s*\n\s*push:\s*\n\s*branches:\s*\[([^\]]*)\]/.exec(corridorText);
      const gotBranches = m ? m[1].split(',').map((s) => s.trim()) : null;
      if (!gotBranches || wantBranches.some((b) => !gotBranches!.includes(b)) || gotBranches.length !== wantBranches.length) {
        fail('release-corridor-triggers', `${corridorRel}: on.push.branches must be exactly ${JSON.stringify(wantBranches)} (from .claude/port.config.json's branches), got ${JSON.stringify(gotBranches)}`);
      } else {
        ok();
      }
    } else {
      note(`release: single-branch mode — ${corridorRel}'s push.branches not checked against branches.production`);
    }

    const lines = corridorText.split(/\r?\n/);
    const jobBlock = extractJobBlock(lines, 'run-release-corridor');
    if (!jobBlock) {
      fail('release-corridor-triggers', `${corridorRel}: job block 'run-release-corridor' not found — a renamed job must fail this check, not pass it vacuously`);
    } else {
      const jobText = jobBlock.join('\n');
      if (!jobText.includes('node scripts/release-corridor.ts')) {
        fail('release-corridor-triggers', `${corridorRel}: job 'run-release-corridor' must run 'node scripts/release-corridor.ts'`);
      } else {
        ok();
      }
      if (!jobText.includes('GH_TOKEN')) {
        fail('release-corridor-triggers', `${corridorRel}: job 'run-release-corridor' must set GH_TOKEN — the script calls gh`);
      } else {
        ok();
      }
    }
  }

  // --- release.postPublishHook: declared in all three places, in shape ------
  // guard(#224): the three-way config contract drifting the way
  // commands.worktrees already guards against.
  // The same three-way contract commands.worktrees already has: string|null
  // with default null in the schema, null in the shipped template, and a
  // non-empty string in this repository's own opted-in config.
  {
    const schema = readJson('schema/port.config.schema.json');
    const prop = schema.properties?.release?.properties?.postPublishHook;
    const wantType = JSON.stringify(['string', 'null']);
    if (!prop || JSON.stringify(prop.type) !== wantType || prop.default !== null) {
      fail('release-post-publish-hook', "schema/port.config.schema.json's release.postPublishHook must be type ['string','null'] with default null");
    } else {
      ok();
    }

    const template = readJson('plugins/port/templates/port.config.json');
    if (template.release?.postPublishHook !== null) {
      fail('release-post-publish-hook', "plugins/port/templates/port.config.json's release.postPublishHook must be null — the shipped default");
    } else {
      ok();
    }

    const selfCfg = readJson('.claude/port.config.json');
    if (typeof selfCfg.release?.postPublishHook !== 'string' || selfCfg.release.postPublishHook.length === 0) {
      fail('release-post-publish-hook', ".claude/port.config.json's release.postPublishHook must be a non-empty string — this repository's own opt-in");
    } else {
      ok();
    }
  }

  // --- release/SKILL.md pin --------------------------------------------------
  // guard(#224): a prose edit quietly dropping the dev-window contract or
  // reintroducing a false "bump already merged" read while a dev window is
  // open.
  // guard(#275): a renamed "Release v<version>" title form would quietly
  // turn every legitimate corridor into a violation, since releaseInFlight's
  // title parser and the skill's own release-title form must agree.
  // A future prose edit that quietly drops the contract fails here rather
  // than in a live release run.
  {
    const rel = 'plugins/port/skills/release/SKILL.md';
    const text = readFileSync(join(root, rel), 'utf8');
    for (const phrase of ['release.postPublishHook', 'skip silently', 'carries no prerelease suffix', 'Release v<version>', 'Release v<X.Y.Z>']) {
      if (!text.includes(phrase)) fail('release-skill-pin', `${rel} no longer says "${phrase}"`);
      else ok();
    }
  }

  // --- scripts/dev-window.ts's pure exports resolve their documented cases -
  // guard(#224): the dev-window restore script computing the wrong next
  // version, or silently defaulting instead of failing, on a malformed
  // manifest.
  {
    if (nextDevWindow('0.2.0', 'dev') !== '0.2.1-dev') {
      fail('dev-window', "nextDevWindow('0.2.0', 'dev') must equal '0.2.1-dev'");
    } else {
      ok();
    }
    if (nextDevWindow('0.2.0', 'dev') === '0.3.0-dev') {
      fail('dev-window', 'nextDevWindow must never guess a minor bump');
    } else {
      ok();
    }

    const decideCases = [
      { name: 'integration suffixed → nothing-to-do', args: { integrationVersion: '0.2.1-dev', next: '0.2.1-dev', devWindowBranchExists: false }, want: 'nothing-to-do' },
      { name: 'integration clean, branch exists → pr-exists', args: { integrationVersion: '0.2.0', next: '0.2.1-dev', devWindowBranchExists: true }, want: 'pr-exists' },
      { name: 'integration clean, no branch → open', args: { integrationVersion: '0.2.0', next: '0.2.1-dev', devWindowBranchExists: false }, want: 'open' },
    ];
    for (const c of decideCases) {
      const got = decide(c.args).action;
      if (got !== c.want) fail('dev-window', `decide self-test '${c.name}': expected '${c.want}', got '${got}'`);
      else ok();
    }

    let threw = false;
    try {
      nextDevWindow('not-a-version');
    } catch {
      threw = true;
    }
    if (!threw) fail('dev-window', 'nextDevWindow must throw on malformed input rather than default');
    else ok();

    threw = false;
    try {
      decide({ integrationVersion: 'not-a-version', next: '0.2.1-dev', devWindowBranchExists: false });
    } catch {
      threw = true;
    }
    if (!threw) fail('dev-window', 'decide must throw on a malformed integration version rather than default');
    else ok();

    if (parseVersion('nope') !== null) fail('dev-window', 'parseVersion must return null, never throw or guess, for malformed input');
    else ok();
  }

  note('release: corridor rail (#224, #275), one-check-per-commit trigger guard, postPublishHook three-way shape, SKILL.md pin, dev-window.ts decision cases');
}
