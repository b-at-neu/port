import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf, readJson } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// guard(#287): a doc naming a concrete package version that goes stale on
// the next release — version-pinned docs go stale as soon as a newer
// version ships, and create confusion about whether the pin is
// load-bearing or just an example. This module scans for a concrete
// version literal in the shipped/repository docs and fails unless the
// literal is explicitly exempted below as genuinely load-bearing.

/** A dotted `X.Y.Z` triple, optionally `v`-prefixed and prerelease-suffixed
 *  (`v0.2.0`, `0.2.1-dev`, `22.18.0`), plus a two-part `Node >= X.Y[.Z]`
 *  floor form (`Node ≥22.18`) — the shape ENGINEERING.md's own Node floor
 *  restatements used to carry, which the first pattern alone would miss. */
const VERSION_RE = /\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g;
const NODE_FLOOR_RE = /\bNode(?:\.js)?\s*(?:≥|>=)\s*\d+(?:\.\d+)*/g;

/** Every concrete version-literal substring in `line`. Pure, so the
 *  self-test below can exercise it directly against literal fixtures
 *  before this module is trusted to scan anything real (ENGINEERING §7: a
 *  check that cannot be made to fail is not a check). */
export function versionLiterals(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(VERSION_RE)) out.push(m[0]);
  for (const m of line.matchAll(NODE_FLOOR_RE)) out.push(m[0]);
  return out;
}

/** The explicit "this is load-bearing" call-out the ticket asks for,
 *  instead of a doc that simply goes quiet about a version it still
 *  names. Each entry excuses exactly one literal in exactly one file —
 *  never a whole file or a bare pattern — so a fresh version literal
 *  introduced elsewhere in the same file still fails. */
interface Exemption {
  file: string;
  literal: string;
  why: string;
}

const EXEMPTIONS: Exemption[] = [
  {
    file: 'plugins/port/skills/release/SKILL.md',
    literal: '1.4.3',
    why: 'a worked bump-arithmetic example for a hypothetical repository, not the version of any package',
  },
  {
    file: 'plugins/port/skills/release/SKILL.md',
    literal: '2.0.0',
    why: 'a worked bump-arithmetic example for a hypothetical repository, not the version of any package',
  },
  {
    file: 'plugins/port/skills/release/SKILL.md',
    literal: '1.5.0',
    why: 'a worked bump-arithmetic example for a hypothetical repository, not the version of any package',
  },
  {
    file: 'plugins/port/skills/release/SKILL.md',
    literal: '1.4.4',
    why: 'a worked bump-arithmetic example for a hypothetical repository, not the version of any package',
  },
  {
    file: 'plugins/port/skills/release/SKILL.md',
    literal: '1.5.0-beta.1',
    why: 'a worked bump-arithmetic example for a hypothetical repository, not the version of any package',
  },
  {
    file: 'CONTRIBUTING.md',
    literal: '22.18.0',
    why: 'the Node compatibility floor, pinned to package.json engines.node by the pin below',
  },
  {
    file: 'CONTRIBUTING.md',
    literal: 'Node ≥22.18.0',
    why: 'the Node compatibility floor, pinned to package.json engines.node by the pin below',
  },
];

/** The same markdown set docs.ts's "Stale references" scan uses: `.md`
 *  files under plugins/, docs/, schema/, evals/ (via walk), plus the three
 *  root docs. YAML eval fixtures are deliberately out — their own
 *  `package.json` versions are test data, not documentation. */
function scanSet(): string[] {
  return [
    ...walk(join(root, 'plugins')),
    ...walk(join(root, 'docs')),
    ...walk(join(root, 'schema')),
    ...walk(join(root, 'evals')),
    join(root, 'README.md'),
    join(root, 'CONTRIBUTING.md'),
    join(root, 'ARCHITECTURE.md'),
  ].filter((f) => f.endsWith('.md') && existsSync(f));
}

export default async function ({ fail, note, ok }: Reporter) {
  // --- versionLiterals self-test ----------------------------------------------
  // A check that cannot be made to fail is not a check (ENGINEERING §7):
  // prove the pattern catches what it exists to catch, and leaves alone what
  // is deliberately not a package version, before trusting it to scan real
  // docs.
  {
    const mustMatch = ['v0.2.0', '0.2.1-dev', '22.18.0', 'Node ≥22.18'];
    const mustNotMatch = ['v<semver>', 'v<version>', '<X.Y.Z>-dev', 'devwindow/v<next>', '~4.5 minutes', '2026-08-31', '/v2/widgets'];
    for (const line of mustMatch) {
      if (versionLiterals(line).length === 0) {
        fail('version-literal-selftest', `versionLiterals(${JSON.stringify(line)}) found nothing — must match`);
      } else {
        ok();
      }
    }
    for (const line of mustNotMatch) {
      const got = versionLiterals(line);
      if (got.length > 0) {
        fail('version-literal-selftest', `versionLiterals(${JSON.stringify(line)}) matched ${JSON.stringify(got)} — must not match`);
      } else {
        ok();
      }
    }
  }

  // --- Scan: no undocumented concrete version literal in the doc set ---------
  {
    const used = new Set<Exemption>();
    const files = scanSet();
    let scanned = 0;
    for (const f of files) {
      const rel = relOf(f);
      scanned++;
      const lines = readFileSync(f, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        for (const literal of versionLiterals(lines[i])) {
          const exemption = EXEMPTIONS.find((e) => e.file === rel && e.literal === literal);
          if (exemption) {
            used.add(exemption);
            ok();
            continue;
          }
          fail(
            'version-literal',
            `${rel}:${i + 1}: names a concrete version (${JSON.stringify(literal)}) — use a placeholder (\`<tag>\`, \`<version>\`, \`<X.Y.Z>\`), or add a justified exemption if it is genuinely load-bearing`,
          );
        }
      }
    }
    note(`version-literal: ${scanned} doc files scanned`);
    ok();

    // --- Stale exemptions --------------------------------------------------
    // guard(#287): an exemption that matches nothing on disk any more is
    // dead weight that stays allowed forever (the same ratchet idea
    // file-size.config.json's allowlist already follows) — a fixed doc
    // should drop its exemption in the same commit, not leave a licence
    // nothing uses.
    for (const exemption of EXEMPTIONS) {
      if (!used.has(exemption)) {
        fail(
          'version-literal-exemption',
          `${exemption.file}: exemption for ${JSON.stringify(exemption.literal)} matches nothing on disk — drop the exemption or the doc changed out from under it`,
        );
      } else {
        ok();
      }
    }
  }

  // --- Node-floor pin: CONTRIBUTING.md ↔ package.json's engines.node --------
  // pin: CONTRIBUTING.md's Node floor ↔ package.json engines.node
  {
    const contributing = readFileSync(join(root, 'CONTRIBUTING.md'), 'utf8');
    const docMatch = /Node ≥(\d+\.\d+\.\d+)/.exec(contributing);
    const engines = readJson('package.json').engines?.node;
    const pkgMatch = typeof engines === 'string' ? /^>=(\d+\.\d+\.\d+)$/.exec(engines) : null;

    if (!docMatch) {
      fail('node-floor-pin', `CONTRIBUTING.md: no "Node ≥X.Y.Z" floor statement found to parse`);
    } else if (!pkgMatch) {
      fail('node-floor-pin', `package.json: engines.node (${JSON.stringify(engines)}) does not parse as ">=X.Y.Z"`);
    } else if (docMatch[1] !== pkgMatch[1]) {
      fail('node-floor-pin', `CONTRIBUTING.md's Node floor (${docMatch[1]}) disagrees with package.json's engines.node (${pkgMatch[1]})`);
    } else {
      ok();
    }
  }
}
