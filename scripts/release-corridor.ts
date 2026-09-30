#!/usr/bin/env node
// Decides whether an open release corridor (#224) is a legitimate, in-flight
// release or the bug #224's corridor rail exists to catch (#275): a corridor
// left open with nothing addressing it.
//
// "Is a release in flight?" can only be answered from GitHub, and layer 1
// must stay offline (docs/ENGINEERING.md §1's pure-logic/I/O split). So the
// decision splits in two:
//   - classifyCorridor/releaseInFlight below are pure and shared by both
//     readers — scripts/checks/release.ts (which always passes
//     inFlight: { checked: false }, since it never calls gh) and this same
//     file's own CLI, which gathers the evidence and calls both for real.
//   - the CLI is the network-aware half, run by the run-release-corridor
//     workflow job on every push to <integration>/<production> — the only
//     place this repository now produces one authoritative
//     run-release-corridor result per (check name, head SHA).
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './lib/files.ts';
import { message } from './lib/errors.ts';

export type CorridorVerdict = 'pass' | 'skip' | 'unresolved' | 'in-flight' | 'violation';

export type InFlightEvidence = { checked: false } | { checked: true; reason: string | null; shipped: boolean; hookCommand: string | null };

/** The corridor rule itself (#224), pure: which branch may carry a
 *  prerelease-suffixed version and which may not, extended by #275 to
 *  distinguish a legitimate in-flight release from the bug #224 catches.
 *  `inFlight` is `{ checked: false }` when the caller never asked GitHub —
 *  layer 1's own case, which can therefore only ever report `unresolved` for
 *  a clean integration branch, never guess at `violation` or `in-flight`. A
 *  branch that is neither the production nor the integration branch — a
 *  feature branch, or `null` for detached `HEAD` — is `skip`, deliberately,
 *  not an omission. */
export function classifyCorridor({
  branch,
  productionName,
  integrationName,
  version,
  hasSuffix,
  inFlight,
}: {
  branch: string | null;
  productionName: string;
  integrationName: string;
  version: string;
  hasSuffix: boolean;
  inFlight: InFlightEvidence;
}): { verdict: CorridorVerdict; message: string } {
  if (branch === productionName) {
    return hasSuffix
      ? { verdict: 'violation', message: `production branch '${productionName}' carries a prerelease suffix` }
      : { verdict: 'pass', message: '' };
  }

  if (branch === integrationName) {
    if (hasSuffix) return { verdict: 'pass', message: '' };

    if (!inFlight.checked) {
      return {
        verdict: 'unresolved',
        message: `release: ${integrationName} at ${version} carries no prerelease suffix — a release corridor is open, and whether a release is in flight needs GitHub, so layer 1 does not decide it: run node scripts/release-corridor.ts`,
      };
    }

    if (inFlight.reason) {
      return {
        verdict: 'in-flight',
        message: `release: ${integrationName} at ${version} carries no prerelease suffix — release corridor open and in flight: ${inFlight.reason}`,
      };
    }

    const fix = inFlight.shipped
      ? `v${version} is published but the dev window was never reopened — run release.postPublishHook (${inFlight.hookCommand ?? 'open a dev-window pull request by hand'})`
      : `v${version} has not shipped — re-run /port:release to resume it`;
    return {
      verdict: 'violation',
      message: `${integrationName} carries clean version ${version} with no release in flight — no open 'Release v${version}' pull request, v${version} not awaiting publish, no open <devWindowBranch> pull request — fix: ${fix}`,
    };
  }

  return { verdict: 'skip', message: '' };
}

/** Whether a release is in flight, from the evidence a caller already
 *  gathered — never touches `gh` itself. Mirrors `release/SKILL.md` §0.5
 *  cases 2–3 plus `dev-window.ts`'s `pr-exists`, so the skill and this check
 *  read the same state the same way. The first match wins. */
export function releaseInFlight({
  version,
  releasePrs,
  productionVersion,
  publishedTags,
  devWindowPrs,
  devWindowBranch,
}: {
  version: string;
  releasePrs: { number: number; title: string }[];
  productionVersion: string;
  publishedTags: { tagName: string; isDraft: boolean }[];
  devWindowPrs: { number: number }[];
  devWindowBranch: string;
}): { reason: string | null; shipped: boolean } {
  const shipped = publishedTags.some((t) => t.tagName === `v${version}` && !t.isDraft);

  for (const pr of releasePrs) {
    const m = /^Release v(.+)$/.exec(pr.title);
    if (!m) {
      // Title renamed and unparseable — release/SKILL.md §0.5 case 2 falls
      // back to the integration branch's own version in this shape, so this
      // still counts as in flight rather than an unrecognized pull request.
      return { reason: `release pull request #${pr.number} is open (title unparseable — adopting v${version}, as /port:release does)`, shipped };
    }
    if (m[1] === version) {
      return { reason: `release pull request #${pr.number} ('Release v${version}') is open`, shipped };
    }
    // Parses to a different version — does not count; keep looking.
  }

  if (productionVersion === version && !shipped) {
    return { reason: `v${version} merged into <production>, not yet published`, shipped: false };
  }

  if (devWindowPrs.length > 0) {
    return { reason: `dev-window pull request #${devWindowPrs[0].number} (${devWindowBranch}) is open`, shipped };
  }

  return { reason: null, shipped };
}

// --- The CLI -----------------------------------------------------------
// Thin wrapper: gather the evidence with `gh`, call the pure functions above,
// print one line per branch, exit non-zero on any violation or unreadable
// evidence. Same standalone-script shape dev-window.ts uses, including the
// `import.meta.url === pathToFileURL(process.argv[1])` guard.

function loadConfig(): { repo: string; integrationName: string; productionName: string | null; manifestRel: string; postPublishHook: string | null } {
  const cfg = JSON.parse(readFileSync(join(root, '.claude/port.config.json'), 'utf8'));
  if (!cfg.repo) throw new Error('.claude/port.config.json: repo is required');
  return {
    repo: cfg.repo,
    integrationName: cfg.branches?.integration ?? 'dev',
    productionName: cfg.branches?.production ?? null,
    manifestRel: (cfg.release?.versionFiles ?? [])[0] ?? 'plugins/port/.claude-plugin/plugin.json',
    postPublishHook: cfg.release?.postPublishHook ?? null,
  };
}

/** Reads `manifestRel`'s `version` at `branch`'s remote tip — never the
 *  checkout, so the verdict is the same from any clone, including CI's
 *  shallow single-ref one. */
function readVersionAt(repo: string, branch: string, manifestRel: string): string {
  let text: string;
  try {
    text = execFileSync('gh', ['api', `repos/${repo}/contents/${manifestRel}?ref=${branch}`, '-H', 'Accept: application/vnd.github.raw'], { encoding: 'utf8' });
  } catch (e) {
    throw new Error(`could not read '${manifestRel}' at '${branch}': ${message(e)}`);
  }
  let manifest: any;
  try {
    manifest = JSON.parse(text);
  } catch (e) {
    throw new Error(`'${manifestRel}' at '${branch}' is not valid JSON: ${message(e)}`);
  }
  if (typeof manifest.version !== 'string') {
    throw new Error(`'${manifestRel}' at '${branch}' has no string 'version' field`);
  }
  return manifest.version;
}

function ghJson(args: string[]): any {
  const out = execFileSync('gh', args, { encoding: 'utf8' });
  return JSON.parse(out);
}

async function main(): Promise<void> {
  const cfg = loadConfig();

  if (cfg.productionName === null) {
    console.log('release: single-branch mode — no release corridor');
    return;
  }
  const productionName = cfg.productionName;
  const integrationName = cfg.integrationName;

  const { parseVersion, nextDevWindow, devWindowBranch } = await import(pathToFileURL(join(root, 'scripts/dev-window.ts')).href);

  let violation = false;

  // --- Production branch: never legitimate with a suffix -------------------
  try {
    const productionVersionRaw = readVersionAt(cfg.repo, productionName, cfg.manifestRel);
    const parsed = parseVersion(productionVersionRaw);
    if (!parsed) throw new Error(`'${productionVersionRaw}' is not well-formed semver`);
    const result = classifyCorridor({
      branch: productionName,
      productionName,
      integrationName,
      version: productionVersionRaw,
      hasSuffix: Boolean(parsed.suffix),
      inFlight: { checked: false },
    });
    if (result.verdict === 'violation') {
      violation = true;
      console.log(`FAIL: ${result.message}`);
    } else {
      console.log(`ok: ${productionName} at ${productionVersionRaw}, no prerelease suffix`);
    }

    // --- Integration branch: needs GitHub to tell a legitimate corridor
    // from #224's own bug ----------------------------------------------
    const integrationVersionRaw = readVersionAt(cfg.repo, integrationName, cfg.manifestRel);
    const integrationParsed = parseVersion(integrationVersionRaw);
    if (!integrationParsed) throw new Error(`'${integrationVersionRaw}' is not well-formed semver`);

    if (integrationParsed.suffix) {
      console.log(`ok: ${integrationName} at ${integrationVersionRaw}, prerelease suffix present — dev window open`);
    } else {
      const releasePrs = ghJson(['pr', 'list', '--repo', cfg.repo, '--base', productionName, '--head', integrationName, '--state', 'open', '--json', 'number,title']);
      const publishedTags = ghJson(['release', 'list', '--repo', cfg.repo, '--limit', '20', '--json', 'tagName,isDraft']);

      let devWindowPrs: { number: number }[] = [];
      let branch = '';
      if (!parsed.suffix) {
        // Only meaningful once production itself carries a clean version —
        // computing it against a still-suffixed production would compute a
        // dev-window branch below the version actually in flight.
        const next = nextDevWindow(productionVersionRaw);
        branch = devWindowBranch(next);
        devWindowPrs = ghJson(['pr', 'list', '--repo', cfg.repo, '--base', integrationName, '--head', branch, '--state', 'open', '--json', 'number']);
      }

      const inFlight = releaseInFlight({
        version: integrationVersionRaw,
        releasePrs,
        productionVersion: productionVersionRaw,
        publishedTags,
        devWindowPrs,
        devWindowBranch: branch,
      });

      const result2 = classifyCorridor({
        branch: integrationName,
        productionName,
        integrationName,
        version: integrationVersionRaw,
        hasSuffix: false,
        inFlight: { checked: true, reason: inFlight.reason, shipped: inFlight.shipped, hookCommand: cfg.postPublishHook },
      });
      if (result2.verdict === 'violation') {
        violation = true;
        console.log(`FAIL: ${result2.message}`);
      } else {
        console.log(`ok: ${result2.message}`);
      }
    }
  } catch (e) {
    // Fails closed on evidence (docs/ENGINEERING.md §4): a `gh` read that
    // exits non-zero, or a manifest that does not parse, is never treated as
    // a release in flight. A red run a re-run clears is better than a green
    // verdict nobody verified.
    console.log(`FAIL: could not read evidence: ${message(e)} — not treated as a release in flight`);
    process.exitCode = 1;
    return;
  }

  process.exitCode = violation ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
