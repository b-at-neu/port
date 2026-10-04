import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { root, readJson, walk, relOf, frontmatter } from '../lib/files.ts';
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

  // --- Pin agreement: init applies and verifies, PREFLIGHT reports drift ------
  // guard(#341): a committed ref change that relied entirely on background
  // reconciliation to actually move the install, and a startup line that
  // printed an unflagged 'current with' even when this machine's registered
  // source disagreed with the committed pin.
  {
    const initRel = 'plugins/port/skills/init/SKILL.md';
    const initPath = join(root, initRel);
    const initText = readFileSync(initPath, 'utf8');
    const initAllowedTools = frontmatter(initPath)?.['allowed-tools'] ?? '';

    for (const entry of ['Bash(claude plugin marketplace remove *)', 'Bash(claude plugin marketplace add *)', 'Bash(claude plugin install *)']) {
      if (!initAllowedTools.includes(entry)) {
        fail('pin-agreement', `${initRel}'s frontmatter allowed-tools is missing '${entry}'`);
      } else {
        ok();
      }
    }

    const removeIdx = initText.indexOf('claude plugin marketplace remove');
    const addIdx = initText.indexOf('claude plugin marketplace add');
    const installIdx = initText.indexOf('claude plugin install');
    if (removeIdx === -1 || addIdx === -1 || installIdx === -1) {
      fail(
        'pin-agreement',
        `${initRel} is missing one of 'claude plugin marketplace remove'/'claude plugin marketplace add'/'claude plugin install'`,
      );
    } else if (!(removeIdx < addIdx && addIdx < installIdx)) {
      fail(
        'pin-agreement',
        `${initRel} does not name 'claude plugin marketplace remove', then 'claude plugin marketplace add', then 'claude plugin install', in that order`,
      );
    } else {
      ok();
    }

    for (const literal of ['Never report the pin applied until', 'verify-only']) {
      if (!initText.includes(literal)) {
        fail('pin-agreement', `${initRel} is missing the literal '${literal}'`);
      } else {
        ok();
      }
    }

    const preflightRel = 'plugins/port/skills/pipeline/PREFLIGHT.md';
    const preflightText = readFileSync(join(root, preflightRel), 'utf8');

    for (const phrase of ['extraKnownMarketplaces', 'aheadBy']) {
      if (!preflightText.includes(phrase)) {
        fail('pin-agreement', `${preflightRel} never names '${phrase}'`);
      } else {
        ok();
      }
    }

    const uxHeadingIdx = preflightText.indexOf('## UX states (startup preflight)');
    if (uxHeadingIdx === -1) {
      fail('pin-agreement', `${preflightRel} is missing the '## UX states (startup preflight)' heading`);
    } else {
      const uxSection = preflightText.slice(uxHeadingIdx);
      const driftMarker = "- **Running plugin doesn't match the committed pin**";
      const misconfigMarker = '- **Committed pin misconfigured**';
      const driftIdx = uxSection.indexOf(driftMarker);
      const misconfigIdx = uxSection.indexOf(misconfigMarker);

      if (driftIdx === -1) {
        fail('pin-agreement', `${preflightRel}'s UX states are missing "${driftMarker}"`);
      } else {
        ok();
      }
      if (misconfigIdx === -1) {
        fail('pin-agreement', `${preflightRel}'s UX states are missing "${misconfigMarker}"`);
      } else {
        ok();
      }

      // Each entry's own text is bounded by the next top-level '- **' bullet,
      // never the whole section — the misconfiguration entry legitimately
      // names '/port:init' and the drift entry legitimately must not.
      if (driftIdx !== -1) {
        const nextBulletIdx = uxSection.indexOf('\n- **', driftIdx + driftMarker.length);
        const driftEntry = nextBulletIdx === -1 ? uxSection.slice(driftIdx) : uxSection.slice(driftIdx, nextBulletIdx);
        if (!driftEntry.includes('claude plugin marketplace remove')) {
          fail('pin-agreement', `${preflightRel}'s drift UX state is missing 'claude plugin marketplace remove'`);
        } else {
          ok();
        }
        if (driftEntry.includes('/port:init')) {
          fail(
            'pin-agreement',
            `${preflightRel}'s drift UX state names '/port:init' — this is the operator's own machine, never the repository maintainer's fix`,
          );
        } else {
          ok();
        }
      }

      if (misconfigIdx !== -1) {
        const nextBulletIdx = uxSection.indexOf('\n- **', misconfigIdx + misconfigMarker.length);
        const misconfigEntry = nextBulletIdx === -1 ? uxSection.slice(misconfigIdx) : uxSection.slice(misconfigIdx, nextBulletIdx);
        if (!misconfigEntry.includes('/port:init')) {
          fail('pin-agreement', `${preflightRel}'s misconfiguration UX state is missing '/port:init'`);
        } else {
          ok();
        }
      }
    }
  }

  // --- The accepted ref forms stay pinned between init and PREFLIGHT ---------
  // pin: scripts/checks/install.ts's MARKETPLACE_REF_PATTERN ↔ the prose in
  // plugins/port/skills/init/SKILL.md and plugins/port/skills/pipeline/PREFLIGHT.md
  // stating what it accepts — a drift here means an operator is told a ref
  // form is fine (or rejected) that the actual validator disagrees with.
  {
    const refFormPhrase = '`main` or a `v<semver>` tag';
    const initRel = 'plugins/port/skills/init/SKILL.md';
    const preflightRel = 'plugins/port/skills/pipeline/PREFLIGHT.md';
    const initText = readFileSync(join(root, initRel), 'utf8');
    const preflightText = readFileSync(join(root, preflightRel), 'utf8');

    if (!initText.includes(refFormPhrase)) {
      fail('pin-agreement', `${initRel} never states the accepted ref forms as '${refFormPhrase}'`);
    } else {
      ok();
    }
    if (!preflightText.includes(refFormPhrase)) {
      fail('pin-agreement', `${preflightRel} never states the accepted ref forms as '${refFormPhrase}'`);
    } else {
      ok();
    }
  }
}
