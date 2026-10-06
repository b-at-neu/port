import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, readJson } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';
import { extractJobBlock } from './portability.ts';

/** Resolves the checked-out branch name from files alone — no `git` subprocess. `null` for a
 *  detached `HEAD` (every CI `pull_request` run checks out the merge ref, never a branch). */
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

/** The top-level `on:` block's direct child keys, or `null` if absent. A whole-file substring
 *  search for `push:` would also match a step named "push", so this reads only the direct children of the top-level `on:` mapping. Handles both the block and inline forms. */
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

export default async function ({ expect, fail, note, ok }: Reporter) {
  const { classifyCorridor, releaseInFlight } = await import(pathToFileURL(join(root, 'scripts/release-corridor.ts')).href);
  const { parseVersion, nextDevWindow, decide, devWindowSubject } = await import(pathToFileURL(join(root, 'scripts/dev-window.ts')).href);

  // --- Integration branch stays on a prerelease version, so a dev-loop install never
  // resolves to the same cache directory as a released consumer. Layer 1 cannot see GitHub, so it must never guess "no release in flight" for a clean integration branch. ---
  {
    const cfg = readJson('.claude/port.config.json');
    const production = cfg.branches?.production;
    if (production === null) {
      note('release: single-branch mode (branches.production is null) — no release corridor to check');
    } else {
      const productionName = production ?? 'main';
      const integrationName = cfg.branches?.integration ?? 'dev';
      const manifestRel = (cfg.release?.versionFiles ?? [])[0] ?? 'plugins/port/.claude-plugin/plugin.json';

      // Self-test first: every row of classifyCorridor's verdict table, plus two message-content cases, before trusting the predicate against real files.
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
        expect(!(got !== c.want), 'release-corridor', `classifyCorridor self-test '${c.name}': expected verdict='${c.want}', got='${got}'`);
      }

      const shippedFix = classifyCorridor({
        branch: 'dev', productionName: 'main', integrationName: 'dev', version: '0.3.0', hasSuffix: false,
        inFlight: { checked: true, reason: null, shipped: true, hookCommand: 'node scripts/dev-window.ts' },
      });
      expect(!(!shippedFix.message.includes('release.postPublishHook') || !shippedFix.message.includes('node scripts/dev-window.ts')), 'release-corridor', "classifyCorridor self-test 'shipped fix': message must name release.postPublishHook and its configured command");
      const unshippedFix = classifyCorridor({
        branch: 'dev', productionName: 'main', integrationName: 'dev', version: '0.3.0', hasSuffix: false,
        inFlight: { checked: true, reason: null, shipped: false, hookCommand: null },
      });
      expect(unshippedFix.message.includes('/port:release'), 'release-corridor', "classifyCorridor self-test 'unshipped fix': message must name /port:release");

      // releaseInFlight self-test: a passing example of each kind of evidence it reads.
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
        expect(!(got.reason !== c.wantReason || got.shipped !== c.wantShipped), 'release-corridor', `releaseInFlight self-test '${c.name}': expected reason=${JSON.stringify(c.wantReason)} shipped=${c.wantShipped}, got reason=${JSON.stringify(got.reason)} shipped=${got.shipped}`);
      }

      const manifest = readJson(manifestRel);
      const parsed = parseVersion(manifest.version);
      if (!parsed) {
        fail('release-corridor', `${manifestRel}'s version '${manifest.version}' is not well-formed semver`);
      } else {
        ok();
        const branch = currentBranch(root);
        // Real evaluation always passes inFlight: { checked: false } — layer 1 never calls gh, so this can only ever report the production arm as a violation; a clean integration branch reports `unresolved`.
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
          // Skip arm, but a note when the version reads clean rather than silence — silence must never be read as a pass.
          note(`release: ${branch === null ? 'detached HEAD' : `branch '${branch}'`} carries a clean version '${manifest.version}' (release corridor not checked here)`);
          ok();
        } else {
          ok();
        }
      }
    }
  }

  // --- One authoritative result per check name and commit — the push trigger must never
  // come back to checks.yml, since its run would land on the open release pull request's own head SHA that pull_request already produced for. ---
  {
    // Self-test onTriggers first, in both directions.
    const syntheticBlock = ['on:', '  push:', '  pull_request:', 'permissions:', '  contents: read'].join('\n');
    const syntheticInline = 'on: push\npermissions:\n  contents: read';
    const syntheticNone = 'name: X\npermissions:\n  contents: read';
    expect(!(JSON.stringify(onTriggers(syntheticBlock)) !== JSON.stringify(['push', 'pull_request'])), 'release-corridor-triggers', 'onTriggers self-test: block form must return its direct child keys in order');
    expect(!(JSON.stringify(onTriggers(syntheticInline)) !== JSON.stringify(['push'])), 'release-corridor-triggers', 'onTriggers self-test: inline scalar form must return a one-element array');
    expect(!(onTriggers(syntheticNone) !== null), 'release-corridor-triggers', 'onTriggers self-test: a file with no on: block must return null');

    const checksRel = '.github/workflows/checks.yml';
    const corridorRel = '.github/workflows/release-corridor.yml';
    const checksText = readFileSync(join(root, checksRel), 'utf8');
    const corridorText = readFileSync(join(root, corridorRel), 'utf8');

    const checksTriggers = onTriggers(checksText);
    expect(!(JSON.stringify(checksTriggers) !== JSON.stringify(['pull_request'])), 'release-corridor-triggers', `${checksRel}: on: must be exactly ['pull_request'], got ${JSON.stringify(checksTriggers)} — a push trigger recreates the two-readers-of-the-same-commit race #275 removed`);

    const corridorTriggers = onTriggers(corridorText);
    expect(!(JSON.stringify(corridorTriggers) !== JSON.stringify(['push'])), 'release-corridor-triggers', `${corridorRel}: on: must be exactly ['push'], got ${JSON.stringify(corridorTriggers)} — adding pull_request or workflow_dispatch would put a second run-release-corridor result on the release pull request's own head SHA`);

    // pin: release-corridor.yml's push branches ↔ .claude/port.config.json branches
    const cfg2 = readJson('.claude/port.config.json');
    if (cfg2.branches?.production !== null) {
      const wantBranches = [cfg2.branches?.integration ?? 'dev', cfg2.branches?.production ?? 'main'];
      const m = /on:\s*\n\s*push:\s*\n\s*branches:\s*\[([^\]]*)\]/.exec(corridorText);
      const gotBranches = m ? m[1].split(',').map((s) => s.trim()) : null;
      expect(!(!gotBranches || wantBranches.some((b) => !gotBranches!.includes(b)) || gotBranches.length !== wantBranches.length), 'release-corridor-triggers', `${corridorRel}: on.push.branches must be exactly ${JSON.stringify(wantBranches)} (from .claude/port.config.json's branches), got ${JSON.stringify(gotBranches)}`);
    } else {
      note(`release: single-branch mode — ${corridorRel}'s push.branches not checked against branches.production`);
    }

    const lines = corridorText.split(/\r?\n/);
    const jobBlock = extractJobBlock(lines, 'run-release-corridor');
    if (!jobBlock) {
      fail('release-corridor-triggers', `${corridorRel}: job block 'run-release-corridor' not found — a renamed job must fail this check, not pass it vacuously`);
    } else {
      const jobText = jobBlock.join('\n');
      expect(jobText.includes('node scripts/release-corridor.ts'), 'release-corridor-triggers', `${corridorRel}: job 'run-release-corridor' must run 'node scripts/release-corridor.ts'`);
      expect(jobText.includes('GH_TOKEN'), 'release-corridor-triggers', `${corridorRel}: job 'run-release-corridor' must set GH_TOKEN — the script calls gh`);
    }
  }

  // --- release.postPublishHook: declared in all three places, in shape — the same three-way
  // contract commands.worktrees already has: string|null, default null, non-empty in this repository's own opt-in. ---
  {
    const schema = readJson('schema/port.config.schema.json');
    const prop = schema.properties?.release?.properties?.postPublishHook;
    const wantType = JSON.stringify(['string', 'null']);
    expect(!(!prop || JSON.stringify(prop.type) !== wantType || prop.default !== null), 'release-post-publish-hook', "schema/port.config.schema.json's release.postPublishHook must be type ['string','null'] with default null");

    const template = readJson('plugins/port/templates/port.config.json');
    expect(!(template.release?.postPublishHook !== null), 'release-post-publish-hook', "plugins/port/templates/port.config.json's release.postPublishHook must be null — the shipped default");

    const selfCfg = readJson('.claude/port.config.json');
    expect(!(typeof selfCfg.release?.postPublishHook !== 'string' || selfCfg.release.postPublishHook.length === 0), 'release-post-publish-hook', ".claude/port.config.json's release.postPublishHook must be a non-empty string — this repository's own opt-in");
  }

  // --- release/SKILL.md pin: a prose edit must never quietly drop the dev-window contract,
  // reintroduce a false "bump already merged" read, or rename the "Release v<version>" title form releaseInFlight's parser depends on. ---
  {
    const rel = 'plugins/port/skills/release/SKILL.md';
    const text = readFileSync(join(root, rel), 'utf8');
    for (const phrase of ['release.postPublishHook', 'skip silently', 'carries no prerelease suffix', 'Release v<version>', 'Release v<X.Y.Z>']) {
      expect(text.includes(phrase), 'release-skill-pin', `${rel} no longer says "${phrase}"`);
    }
  }

  // --- scripts/dev-window.ts's pure exports resolve their documented cases — must never
  // compute the wrong next version, or silently default instead of failing, on a malformed manifest. ---
  {
    expect(!(nextDevWindow('0.2.0', 'dev') !== '0.2.1-dev'), 'dev-window', "nextDevWindow('0.2.0', 'dev') must equal '0.2.1-dev'");
    expect(!(nextDevWindow('0.2.0', 'dev') === '0.3.0-dev'), 'dev-window', 'nextDevWindow must never guess a minor bump');

    const decideCases = [
      { name: 'integration suffixed → nothing-to-do', args: { integrationVersion: '0.2.1-dev', next: '0.2.1-dev', devWindowBranchExists: false }, want: 'nothing-to-do' },
      { name: 'integration clean, branch exists → pr-exists', args: { integrationVersion: '0.2.0', next: '0.2.1-dev', devWindowBranchExists: true }, want: 'pr-exists' },
      { name: 'integration clean, no branch → open', args: { integrationVersion: '0.2.0', next: '0.2.1-dev', devWindowBranchExists: false }, want: 'open' },
    ];
    for (const c of decideCases) {
      const got = decide(c.args).action;
      expect(!(got !== c.want), 'dev-window', `decide self-test '${c.name}': expected '${c.want}', got '${got}'`);
    }

    let threw = false;
    try {
      nextDevWindow('not-a-version');
    } catch {
      threw = true;
    }
    expect(threw, 'dev-window', 'nextDevWindow must throw on malformed input rather than default');

    threw = false;
    try {
      decide({ integrationVersion: 'not-a-version', next: '0.2.1-dev', devWindowBranchExists: false });
    } catch {
      threw = true;
    }
    expect(threw, 'dev-window', 'decide must throw on a malformed integration version rather than default');

    expect(!(parseVersion('nope') !== null), 'dev-window', 'parseVersion must return null, never throw or guess, for malformed input');
  }

  // --- scripts/dev-window.ts's subject carries no ticket prefix — the restore commit and
  // PR title must never regrow a '#0' prefix the bump commit deliberately omits. ---
  {
    expect(!(devWindowSubject('0.2.1-dev') !== 'open dev window for v0.2.1-dev'), 'dev-window', "devWindowSubject('0.2.1-dev') must equal 'open dev window for v0.2.1-dev'");
    expect(!/^#\d+\s/.test(devWindowSubject('0.2.1-dev')), 'dev-window', 'devWindowSubject must never carry a ticket-number prefix');
    const devWindowSource = readFileSync(join(root, 'scripts/dev-window.ts'), 'utf8');
    expect(!/#\d+ open dev window/.test(devWindowSource), 'dev-window', 'scripts/dev-window.ts must not carry an inline "#<n> open dev window" literal — use devWindowSubject at every call site');
  }

  note('release: corridor rail (#224, #275), one-check-per-commit trigger guard, postPublishHook three-way shape, SKILL.md pin, dev-window.ts decision cases, dev-window subject (#278)');
}
