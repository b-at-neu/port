import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, readJson } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

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

/** The corridor rule itself (#224), pure: which branch may carry a
 *  prerelease-suffixed version and which may not. Returns a violation
 *  message or `null`. A branch that is neither the production nor the
 *  integration branch — a feature branch, or `null` for detached `HEAD` — is
 *  never checked here; that skip is deliberate, not an omission. */
export function corridorViolation({
  branch,
  productionName,
  integrationName,
  hasSuffix,
}: {
  branch: string | null;
  productionName: string;
  integrationName: string;
  hasSuffix: boolean;
}): string | null {
  if (branch === productionName) {
    return hasSuffix ? `production branch '${productionName}' carries a prerelease suffix` : null;
  }
  if (branch === integrationName) {
    return !hasSuffix
      ? `integration branch '${integrationName}' carries no prerelease suffix — a released consumer could be pinned to the same cache directory`
      : null;
  }
  return null;
}

export default async function ({ fail, note, ok }: Reporter) {
  const { parseVersion, nextDevWindow, decide } = await import(pathToFileURL(join(root, 'scripts/dev-window.ts')).href);

  // --- Integration branch stays on a prerelease version (#224) ---------------
  // guard(#224): a dev-loop install and a released consumer install both
  // resolving to the same versioned plugin cache directory, so developing
  // port silently overwrites what other repositories run.
  {
    const cfg = readJson('.claude/port.config.json');
    const production = cfg.branches?.production;
    if (production === null) {
      note('release: single-branch mode (branches.production is null) — no release corridor to check');
    } else {
      const productionName = production ?? 'main';
      const integrationName = cfg.branches?.integration ?? 'dev';
      const manifestRel = (cfg.release?.versionFiles ?? [])[0] ?? 'plugins/port/.claude-plugin/plugin.json';

      // Self-test first (ENGINEERING §7): a passing and a failing example of
      // both directions, plus the two skip cases, before trusting the
      // predicate against real files.
      const cases = [
        { name: 'production, clean', args: { branch: 'main', productionName: 'main', integrationName: 'dev', hasSuffix: false }, wantViolation: false },
        { name: 'production, suffixed', args: { branch: 'main', productionName: 'main', integrationName: 'dev', hasSuffix: true }, wantViolation: true },
        { name: 'integration, suffixed', args: { branch: 'dev', productionName: 'main', integrationName: 'dev', hasSuffix: true }, wantViolation: false },
        { name: 'integration, clean', args: { branch: 'dev', productionName: 'main', integrationName: 'dev', hasSuffix: false }, wantViolation: true },
        { name: 'feature branch, clean — skip', args: { branch: '224-ticket', productionName: 'main', integrationName: 'dev', hasSuffix: false }, wantViolation: false },
        { name: 'detached, suffixed — skip', args: { branch: null, productionName: 'main', integrationName: 'dev', hasSuffix: true }, wantViolation: false },
      ];
      for (const c of cases) {
        const got = corridorViolation(c.args) !== null;
        if (got !== c.wantViolation) fail('release-corridor', `corridorViolation self-test '${c.name}': expected violation=${c.wantViolation}, got=${got}`);
        else ok();
      }

      const manifest = readJson(manifestRel);
      const parsed = parseVersion(manifest.version);
      if (!parsed) {
        fail('release-corridor', `${manifestRel}'s version '${manifest.version}' is not well-formed semver`);
      } else {
        ok();
        const branch = currentBranch(root);
        const violation = corridorViolation({ branch, productionName, integrationName, hasSuffix: Boolean(parsed.suffix) });
        if (violation) {
          fail(
            'release-corridor',
            `${violation} — fix: merge the open devwindow/v<next> pull request (or the release corridor fix), never hand-edit ${manifestRel}`,
          );
        } else if (branch !== productionName && branch !== integrationName && !parsed.suffix) {
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
  // A future prose edit that quietly drops the contract fails here rather
  // than in a live release run.
  {
    const rel = 'plugins/port/skills/release/SKILL.md';
    const text = readFileSync(join(root, rel), 'utf8');
    for (const phrase of ['release.postPublishHook', 'skip silently', 'carries no prerelease suffix']) {
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

  note('release: corridor rail (#224), postPublishHook three-way shape, SKILL.md pin, dev-window.ts decision cases');
}
