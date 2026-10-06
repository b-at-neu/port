import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf, readJson } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// Scans shipped/repository docs for a concrete version literal, failing unless it is
// explicitly exempted below as genuinely load-bearing.

/** A dotted `X.Y.Z` triple, optionally `v`-prefixed and prerelease-suffixed, plus a
 *  `Node >= X.Y[.Z]` floor form that the first pattern alone would miss. */
const VERSION_RE = /\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g;
const NODE_FLOOR_RE = /\bNode(?:\.js)?\s*(?:≥|>=)\s*\d+(?:\.\d+)*/g;

/** Every concrete version-literal substring in `line`. Pure, so the self-test below can
 *  exercise it directly before this module is trusted to scan anything real. */
export function versionLiterals(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(VERSION_RE)) out.push(m[0]);
  for (const m of line.matchAll(NODE_FLOOR_RE)) out.push(m[0]);
  return out;
}

/** An explicit "this is load-bearing" call-out. Each entry excuses exactly one literal in
 *  exactly one file — never a whole file — so a fresh literal elsewhere still fails. */
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

/** The same markdown set docs.ts's "Stale references" scan uses. YAML eval fixtures are out
 *  — their own `package.json` versions are test data, not documentation. */
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

export default async function ({ expect, fail, note, ok }: Reporter) {
  // --- versionLiterals self-test: proves the pattern catches what it should and leaves alone what is not a package version, before scanning real docs. ---
  {
    const mustMatch = ['v0.2.0', '0.2.1-dev', '22.18.0', 'Node ≥22.18'];
    const mustNotMatch = ['v<semver>', 'v<version>', '<X.Y.Z>-dev', 'devwindow/v<next>', '~4.5 minutes', '2026-08-31', '/v2/widgets'];
    for (const line of mustMatch) {
      expect(!(versionLiterals(line).length === 0), 'version-literal-selftest', `versionLiterals(${JSON.stringify(line)}) found nothing — must match`);
    }
    for (const line of mustNotMatch) {
      const got = versionLiterals(line);
      expect(!(got.length > 0), 'version-literal-selftest', `versionLiterals(${JSON.stringify(line)}) matched ${JSON.stringify(got)} — must not match`);
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

    // --- Stale exemptions: one matching nothing on disk is dead weight that stays allowed forever. ---
    for (const exemption of EXEMPTIONS) {
      expect(used.has(exemption), 'version-literal-exemption', `${exemption.file}: exemption for ${JSON.stringify(exemption.literal)} matches nothing on disk — drop the exemption or the doc changed out from under it`);
    }
  }

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
    } else expect(!(docMatch[1] !== pkgMatch[1]), 'node-floor-pin', `CONTRIBUTING.md's Node floor (${docMatch[1]}) disagrees with package.json's engines.node (${pkgMatch[1]})`);
  }
}
