import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, readJson } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

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
  {
    const readme = readFileSync(join(root, 'CONTRIBUTING.md'), 'utf8');
    for (const m of readme.matchAll(/cache\/port\/port\/(\S+?)[\s/`]/g)) {
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
}
