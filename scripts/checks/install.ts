import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { root, readJson, walk, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// Structural equality for the small, JSON-shaped values this module compares
// (an `owner` object) — never relies on key order, unlike a JSON.stringify
// comparison would.
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ak = Object.keys(a as object).sort();
  const bk = Object.keys(b as object).sort();
  if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
  return ak.every((k) => deepEqual((a as any)[k], (b as any)[k]));
}

// `ref` is legitimately either the release branch ('main') — this
// repository's own committed, contributor-facing pin — or a `v<semver>`
// release tag, which is what `/port:init` resolves for an adopting
// repository once a version has actually been published. Both forms are a
// deliberate pin; only the unpinned, ref-less shape `marketplace add` leaves
// behind is the drift this check guards against.
const MARKETPLACE_REF_PATTERN = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export default async function ({ fail, ok }: Reporter) {
  // --- Self-hosted marketplace entry stays pinned -----------------------------
  // guard(#146): a bare `claude plugin marketplace add` rewriting the entry
  // back to its unpinned form, silently tracking the default branch instead
  // of a release.
  {
    const settings = readJson('.claude/settings.json');
    const port = settings.extraKnownMarketplaces?.port;
    const ref = port?.source?.ref;
    if (ref !== 'main' && !MARKETPLACE_REF_PATTERN.test(ref ?? '')) {
      fail('marketplace', `extraKnownMarketplaces.port.source.ref must be 'main' or a 'v<semver>' tag, got ${JSON.stringify(ref)}`);
    }
    if (port?.autoUpdate !== true) {
      fail('marketplace', `extraKnownMarketplaces.port.autoUpdate must be true, got ${JSON.stringify(port?.autoUpdate)}`);
    }
    ok();
  }

  // --- CONTRIBUTING's cache path names no hard-coded version (#224) -----------
  // guard(#224): the three-way ground-truth recipe naming a literal released
  // version instead of '<version>' — the observed failure was the recipe
  // still reading '0.1.0' two releases later, which by then pointed at the
  // wrong directory entirely rather than merely a stale one.
  // guard(#343): widened to also match the dev-loop's own cache segment
  // (`cache/port-dev/port/<version>`) — the rewritten recipe line would
  // otherwise leave the guard's coverage silently.
  {
    const readme = readFileSync(join(root, 'CONTRIBUTING.md'), 'utf8');
    for (const m of readme.matchAll(/cache\/port(?:-dev)?\/port\/(\S+?)[\s/`]/g)) {
      if (m[1] !== '<version>') {
        fail('install-cache-path', `CONTRIBUTING.md's cache path names a literal version ('${m[1]}') instead of '<version>' — it will read wrong the moment this repository releases again`);
      } else {
        ok();
      }
    }
  }

  // --- README's documented install source stays pinned ------------------------
  // guard(#146): a docs edit quietly restoring default-branch tracking on
  // the very command adopters copy-paste. `owner/repo@ref` and
  // `owner/repo#ref` both parse; only a bare, ref-less source is disallowed.
  {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    for (const line of readme.split('\n')) {
      const m = /claude plugin marketplace add\s+(\S+)/.exec(line);
      if (!m || !m[1].startsWith('b-at-neu/port')) continue;
      if (!/^b-at-neu\/port[@#]/.test(m[1])) {
        fail('marketplace', `README.md: marketplace add source must carry an @<ref> or #<ref> pin, got ${JSON.stringify(m[1])}`);
      }
    }
    ok();
  }

  // --- Install docs keep live source and pinned install apart (#282) ----------
  // guard(#282): README's inventory section presenting `claude plugin details`
  // alone as what is installed, and the machine-wide marketplace-name note
  // dropping out of README or CONTRIBUTING.
  {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const contributing = readFileSync(join(root, 'CONTRIBUTING.md'), 'utf8');

    const heading = '### Checking the component inventory';
    const headingIndex = readme.indexOf(heading);
    if (headingIndex === -1) {
      fail('install-docs', 'README.md: "### Checking the component inventory" heading not found');
    } else {
      const after = readme.slice(headingIndex + heading.length);
      const nextHeading = /\n#{1,3} /.exec(after);
      const section = nextHeading ? after.slice(0, nextHeading.index) : after;
      if (!section.includes('claude plugin details')) {
        fail('install-docs', 'README.md\'s inventory section no longer mentions `claude plugin details`');
      } else if (!section.includes('claude plugin list')) {
        fail('install-docs', 'README.md\'s inventory section no longer mentions `claude plugin list`');
      } else {
        ok();
      }
    }

    for (const [name, text] of [['README.md', readme], ['CONTRIBUTING.md', contributing]] as const) {
      if (!/one live source per marketplace name/i.test(text)) {
        fail('install-docs', `${name} no longer states 'one live source per marketplace name'`);
      } else {
        ok();
      }
    }
  }

  // --- Dev-loop marketplace stays apart from the consumer one (#343) ---------
  // guard(#343): a dev-loop registration sharing the consumer-facing
  // marketplace name, so the most recently added source silently wins for
  // every repository on the machine that resolves it, regardless of scope.
  // pin: plugins/.claude-plugin/marketplace.json ↔ .claude-plugin/marketplace.json
  {
    const devManifestRel = 'plugins/.claude-plugin/marketplace.json';
    const rootManifestRel = '.claude-plugin/marketplace.json';
    let dev: any;
    try {
      dev = readJson(devManifestRel);
    } catch {
      fail('install-dev-marketplace', `${devManifestRel} is missing or does not parse as JSON`);
    }

    if (dev !== undefined) {
      const rootManifest = readJson(rootManifestRel);

      if (dev.name === rootManifest.name) {
        fail(
          'install-dev-marketplace',
          `${devManifestRel}'s name ('${dev.name}') must differ from ${rootManifestRel}'s — that is the collision this ticket exists to prevent`,
        );
      } else {
        ok();
      }

      if (!deepEqual(dev.owner, rootManifest.owner)) {
        fail('install-dev-marketplace', `${devManifestRel}'s owner must deep-equal ${rootManifestRel}'s`);
      } else {
        ok();
      }

      const devPlugins = Array.isArray(dev.plugins) ? dev.plugins : [];
      if (devPlugins.length !== 1) {
        fail('install-dev-marketplace', `${devManifestRel} must declare exactly one plugin entry, found ${devPlugins.length}`);
      } else {
        ok();
        const devEntry = devPlugins[0];
        const rootEntry = (rootManifest.plugins ?? [])[0];

        if (!rootEntry || devEntry.name !== rootEntry.name) {
          fail('install-dev-marketplace', `${devManifestRel}'s plugin entry name must match ${rootManifestRel}'s`);
        } else {
          ok();
        }
        if (!rootEntry || devEntry.description !== rootEntry.description) {
          fail('install-dev-marketplace', `${devManifestRel}'s plugin entry description must match ${rootManifestRel}'s`);
        } else {
          ok();
        }

        const devResolved = resolve(root, 'plugins', devEntry.source ?? '');
        const rootResolved = resolve(root, rootEntry?.source ?? '');
        if (devResolved !== rootResolved) {
          fail(
            'install-dev-marketplace',
            `${devManifestRel}'s plugin source ('${devEntry.source}', resolved from plugins/) must resolve to the same directory as ${rootManifestRel}'s ('${rootEntry?.source}', resolved from the repository root)`,
          );
        } else {
          ok();
        }

        // devName is read off the manifest, never typed as a literal —
        // a later rename must not need this check rewritten.
        const devName: string = dev.name;
        const rootName: string = rootManifest.name;
        const pluginName: string = devEntry.name;

        const readmeText = readFileSync(join(root, 'README.md'), 'utf8');
        if (readmeText.includes(devName)) {
          fail('install-dev-marketplace', `README.md names the dev-loop marketplace ('${devName}') — a surface every consumer reads`);
        } else {
          ok();
        }

        let anyShippedHit = false;
        for (const f of walk(join(root, 'plugins/port'))) {
          if (readFileSync(f, 'utf8').includes(devName)) {
            anyShippedHit = true;
            fail('install-dev-marketplace', `${relOf(f)} names the dev-loop marketplace ('${devName}') — every file under plugins/port/ ships to an adopter`);
          }
        }
        if (!anyShippedHit) ok();

        const contributingText = readFileSync(join(root, 'CONTRIBUTING.md'), 'utf8');
        if (!contributingText.includes(`claude plugin install ${pluginName}@${devName} --scope local`)) {
          fail('install-dev-marketplace', `CONTRIBUTING.md is missing 'claude plugin install ${pluginName}@${devName} --scope local'`);
        } else {
          ok();
        }
        if (!contributingText.includes(`claude plugin disable ${pluginName}@${rootName} --scope local`)) {
          fail('install-dev-marketplace', `CONTRIBUTING.md is missing 'claude plugin disable ${pluginName}@${rootName} --scope local'`);
        } else {
          ok();
        }
        if (contributingText.includes(`claude plugin install ${pluginName}@${rootName} --scope local`)) {
          fail(
            'install-dev-marketplace',
            `CONTRIBUTING.md still carries the old shared-name recipe ('claude plugin install ${pluginName}@${rootName} --scope local')`,
          );
        } else {
          ok();
        }

        let anyBadAddSrc = false;
        for (const m of contributingText.matchAll(/claude plugin marketplace add\s+(\S+)/g)) {
          const src = m[1];
          if (!src.startsWith('b-at-neu/port') && !src.endsWith('/plugins')) {
            anyBadAddSrc = true;
            fail('install-dev-marketplace', `CONTRIBUTING.md's 'marketplace add ${src}' is neither the GitHub source nor a path ending '/plugins'`);
          }
        }
        if (!anyBadAddSrc) ok();

        // Every `<plugin>@<x>` token not preceded by `/` (which would make it
        // part of an `owner/repo@ref` GitHub source, not a marketplace name)
        // must name a marketplace this ticket actually declares — catches a
        // later rename that misses one of these three files.
        let anyBadAt = false;
        for (const [name, text] of [
          ['CONTRIBUTING.md', contributingText],
          ['docs/TESTING.md', readFileSync(join(root, 'docs/TESTING.md'), 'utf8')],
          ['evals/README.md', readFileSync(join(root, 'evals/README.md'), 'utf8')],
        ] as const) {
          for (const m of text.matchAll(/(?<!\/)\b([A-Za-z0-9_-]+)@([A-Za-z0-9_-]+)\b/g)) {
            const [, p, x] = m;
            if (p !== pluginName || x === rootName || x === devName) continue;
            anyBadAt = true;
            fail('install-dev-marketplace', `${name} names '${p}@${x}', which is neither '${p}@${rootName}' nor '${p}@${devName}'`);
          }
        }
        if (!anyBadAt) ok();
      }
    }
  }
}
