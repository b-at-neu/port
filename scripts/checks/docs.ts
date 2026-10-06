import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { root, walk, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';
import { message } from '../lib/errors.ts';

// A hyphenation or spacing mutation of the marker drops the two-word substring the scans
// below key on, which also pins PIPELINE.md's canonical example to the exact form expected elsewhere.
const SESSION_MARKER_LINE = /^>\s*\*\*SESSION REQUIRED:\*\*\s+\S/;

export default async function ({ expect, fail, note, ok }: Reporter) {
  // --- Stale references: docs naming things that were renamed or moved. ---
  {
    const docs = [
      ...walk(join(root, 'plugins')),
      ...walk(join(root, 'docs')),
      ...walk(join(root, 'schema')),
      ...walk(join(root, 'evals')),
      join(root, 'README.md'),
      join(root, 'CONTRIBUTING.md'),
      join(root, 'ARCHITECTURE.md'),
    ].filter((f) => f.endsWith('.md') && existsSync(f));

    const banned: [RegExp, string, ((line: string) => boolean)?][] = [
      [/\bport-init\b/, 'the installer skill is `init`, invoked as /port:init'],
      [
        /`port\.config\.json`/,
        'the config lives at `.claude/port.config.json`',
        // /port:init's migration step names the legacy root location on purpose.
        (line) => line.includes('repository root'),
      ],
      [/(^|[^:\w/])\/(pipeline|scope|implement|release|worktree-clean|plugin-cache-clean|analyze|init)\b/, 'skill references need the `port:` prefix'],
    ];
    for (const f of docs) {
      const rel = relOf(f);
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        for (const [re, why, exempt] of banned) {
          const m = re.exec(line);
          if (m && !(exempt && exempt(line))) {
            fail('stale-reference', `${rel}: ${why} (found ${JSON.stringify(m[0].trim())})`);
          }
        }
      }
    }
    ok();
  }

  // --- Shipped references stay inside plugins/port/: a shipped file referencing a
  // repository-only doc or script dangles in every adopter's plugin cache. `expandCandidates` decomposes a token so a path riding inside a command or placeholder is still seen. ---
  {
    const EXTENSIONS = ['md', 'mjs', 'js', 'ts', 'json', 'yml', 'yaml', 'log', 'graphql', 'txt'];
    const EXT_RE = new RegExp(`\\.(${EXTENSIONS.join('|')})$`);
    const pluginRoot = join(root, 'plugins/port');

    /** Backticked spans plus bare whitespace-delimited tokens, stripped of surrounding
     *  punctuation and kept only when path-shaped: contains a slash, or ends in a known text extension. */
    function candidateTokens(line: string): string[] {
      const backticked = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
      const bare = line
        .replace(/`[^`]*`/g, ' ')
        .split(/\s+/)
        .map((t) => t.replace(/^["'(\[]+/, '').replace(/[.,;:!?"')\]]+$/, ''))
        .filter(Boolean);
      return [...backticked, ...bare].filter((t) => t.includes('/') || EXT_RE.test(t));
    }

    /** Decomposes one raw token into every path-shaped sub-token, since a token can carry a
     *  repository-only path rather than be one (e.g. `<root>/scripts/checks.ts` resolves as `scripts/checks.ts`). */
    function expandCandidates(token: string): string[] {
      const out: string[] = [token];
      const wrapper = /^[A-Za-z][A-Za-z0-9_]*\((.*)\)$/.exec(token);
      const body = wrapper ? wrapper[1] : token;
      if (wrapper) out.push(body);
      for (const raw of body.split(/[\s;|&]+/)) {
        const word = raw.replace(/^["'(\[]+/, '').replace(/[.,;:!?"')\]]+$/, '');
        if (!word) continue;
        out.push(word);
        if (!word.includes('<')) continue;
        const kept = word.split('/').filter((seg) => !/^<[^<>]*>$/.test(seg));
        if (kept.length === 0 || kept.some((seg) => /[<>*]/.test(seg))) continue;
        out.push(kept.join('/'));
      }
      return [...new Set(out)].filter((t) => t.includes('/') || EXT_RE.test(t));
    }

    /** Pure classifier. Returns 'pass' (resolves inside plugins/port/), 'fail' (resolves
     *  only outside it), or 'skip' (templated, relative, dotfile, or resolves nowhere). */
    function classifyShippedReference(token: string, { pluginRoot, repoRoot, containingDir }: { pluginRoot: string; repoRoot: string; containingDir: string | null }): string {
      if (/[<>*]/.test(token)) return 'skip';
      if (token.includes('${') && !token.startsWith('${CLAUDE_PLUGIN_ROOT}/')) return 'skip';
      let rest = token;
      if (rest.startsWith('${CLAUDE_PLUGIN_ROOT}/')) rest = rest.slice('${CLAUDE_PLUGIN_ROOT}/'.length);
      if (rest.startsWith('./') || rest.startsWith('../')) return 'skip';
      if (rest.split('/')[0].startsWith('.')) return 'skip';
      if (containingDir && existsSync(join(containingDir, rest))) return 'skip';
      if (existsSync(join(pluginRoot, rest))) return 'pass';
      if (existsSync(join(repoRoot, rest))) return 'fail';
      return 'skip';
    }

    // Prove it can fail before trusting it to pass — the real historical failure (docs/USAGE.md) is the first case.
    const selfTestCases = [
      ['docs/USAGE.md', 'fail'],
      ['CONTRIBUTING.md', 'fail'],
      ['scripts/checks.ts', 'fail'],
      ['schema/port.config.schema.json', 'fail'],
      ['plugins/port/skills/pipeline/SKILL.md', 'fail'],
      ['${CLAUDE_PLUGIN_ROOT}/docs/PIPELINE.md', 'pass'],
      ['bin/artifacts.mjs', 'pass'],
      ['skills/pipeline/SKILL.md', 'pass'],
      ['.claude/port.config.json', 'skip'],
      ['.claude-plugin/marketplace.json', 'skip'],
      ['.temp/plan-N.md', 'skip'],
      ['scripts/port-artifacts.mjs', 'skip'],
      ['./lib/guard-rules.mjs', 'skip'],
    ];
    for (const [token, expected] of selfTestCases) {
      const got = classifyShippedReference(token, { pluginRoot, repoRoot: root, containingDir: null });
      expect(!(got !== expected), 'shipped-reference-selftest', `classifyShippedReference(${JSON.stringify(token)}) = ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
    }

    // The worst verdict across a token's expansion is what the scan acts on, so these assert that worst verdict, not the bare token's.
    const worstOf = (token: string): string => {
      const verdicts = expandCandidates(token).map((t) =>
        classifyShippedReference(t, { pluginRoot, repoRoot: root, containingDir: null }),
      );
      return verdicts.includes('fail') ? 'fail' : verdicts.includes('pass') ? 'pass' : 'skip';
    };
    const expansionCases = [
      ['Bash(node scripts/checks.ts)', 'fail'],
      ['node scripts/checks.ts', 'fail'],
      ['node <root>/scripts/checks.ts', 'fail'],
      ['node scripts/checks.ts; <anything>', 'fail'],
      // Still-legitimate forms: a shipped path behind a command prefix, an adopter-only install target, a templated path whose placeholder is only part of a segment.
      ['node bin/artifacts.mjs check commit .temp/m.txt', 'pass'],
      ['Bash(node scripts/port-artifacts.mjs *)', 'skip'],
      ['repos/<repo>/pulls/<pr-number>/comments', 'skip'],
      ['scripts/checks-<topic>.ts', 'skip'],
    ];
    for (const [token, expected] of expansionCases) {
      const got = worstOf(token);
      expect(!(got !== expected), 'shipped-reference-selftest', `expansion of ${JSON.stringify(token)} = ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
    }

    // The real scan — every shipped file, not just markdown, since a stray comment in a `.ts` template is a real historical failure mode.
    const files = walk(pluginRoot).filter((f) => EXT_RE.test(f));
    let confirmedShipped = 0;
    for (const f of files) {
      const rel = relOf(f);
      const containingDir = dirname(f);
      const fileLines = readFileSync(f, 'utf8').split('\n');
      for (let i = 0; i < fileLines.length; i++) {
        for (const raw of candidateTokens(fileLines[i])) {
          for (const token of expandCandidates(raw)) {
            const verdict = classifyShippedReference(token, { pluginRoot, repoRoot: root, containingDir });
            if (verdict === 'fail') {
              fail('shipped-reference', `${rel}:${i + 1}: references \`${token}\`, which exists only outside plugins/port/ — it dangles in an adopter's plugin cache`);
            } else if (verdict === 'pass') {
              ok();
              confirmedShipped++;
            }
          }
        }
      }
    }
    note(`shipped-reference: ${files.length} files scanned, ${confirmedShipped} references confirmed shipped`);
    ok();
  }

  // --- SESSION REQUIRED never rendered as a bare, uncoded marker line: every mention is
  // either inside backticks or the canonical `> **SESSION REQUIRED:** <reason>` rendering. ---
  {
    const docs = [
      ...walk(join(root, 'plugins')),
      ...walk(join(root, 'docs')),
      ...walk(join(root, 'schema')),
      ...walk(join(root, 'evals')),
      join(root, 'README.md'),
      join(root, 'CONTRIBUTING.md'),
      join(root, 'ARCHITECTURE.md'),
    ].filter((f) => f.endsWith('.md') && existsSync(f));

    for (const f of docs) {
      const rel = relOf(f);
      const text = readFileSync(f, 'utf8');
      // Skip YAML frontmatter — a skill's `description:` line may name the marker bare, and no frontmatter value uses backticks.
      const fm = /^---\n[\s\S]*?\n---\n?/.exec(text);
      const fileLines = text.split('\n');
      const startLine = fm ? fm[0].split('\n').length - 1 : 0;
      for (let i = startLine; i < fileLines.length; i++) {
        const line = fileLines[i];
        if (!line.includes('SESSION REQUIRED')) continue;
        if (SESSION_MARKER_LINE.test(line.trim())) continue;
        const outsideBackticks = line.replace(/`[^`]*`/g, '');
        if (outsideBackticks.includes('SESSION REQUIRED')) {
          fail(
            'session-required-rendering',
            `${rel}:${i + 1}: 'SESSION REQUIRED' appears outside inline code and is not the canonical '> **SESSION REQUIRED:** <reason>' rendering`,
          );
        }
      }
    }
    ok();
  }

  {
    const rel = 'plugins/port/docs/PIPELINE.md';
    const fileLines = readFileSync(join(root, rel), 'utf8').split('\n');
    const anchor = 'One string, one rendering, both surfaces';
    const anchorIdx = fileLines.findIndex((l) => l.includes(anchor));
    if (anchorIdx === -1) {
      fail('session-required-rendering', `${rel} no longer declares the canonical marker anchor '${anchor}'`);
    } else {
      let exampleIdx = -1;
      for (let i = anchorIdx + 1; i < Math.min(anchorIdx + 8, fileLines.length); i++) {
        if (fileLines[i].trim().startsWith('>')) {
          exampleIdx = i;
          break;
        }
      }
      if (exampleIdx === -1) {
        fail('session-required-rendering', `${rel}:${anchorIdx + 1}: no blockquote example follows the canonical marker anchor`);
      } else expect(SESSION_MARKER_LINE.test(fileLines[exampleIdx].trim()), 'session-required-rendering', `${rel}:${exampleIdx + 1}: canonical marker example is not '> **SESSION REQUIRED:** <reason>', got ${JSON.stringify(fileLines[exampleIdx].trim())}`);
    }
  }

  // --- Session-required determination reads the whole plan, not just changes — a plan whose
  // testing steps need a sessionRequiredPaths write must not be declared plainly dispatchable. ---
  {
    const planAgent = readFileSync(join(root, 'plugins/port/agents/plan-agent.md'), 'utf8');
    const implAgent = readFileSync(join(root, 'plugins/port/agents/impl-agent.md'), 'utf8');

    const start = planAgent.indexOf('**Session-required declaration.**');
    if (start === -1) {
      fail('session-required-scan', 'plugins/port/agents/plan-agent.md has no "Session-required declaration" section');
    } else {
      const rest = planAgent.slice(start);
      // Scope tightly to the declaration's determination paragraph — stop at the first blank line, not the next `## ` heading.
      const end = /\n\s*\n/.exec(rest);
      const section = end ? rest.slice(0, end.index) : rest;
      for (const heading of ['## Testing', '## Changes']) {
        if (!section.includes(heading)) {
          fail('session-required-scan', `plan-agent.md's Session-required declaration does not name '${heading}' as scanned`);
        }
      }
      ok();
    }

    for (const [rel, text] of [
      ['plugins/port/agents/plan-agent.md', planAgent],
      ['plugins/port/agents/impl-agent.md', implAgent],
    ]) {
      expect(text.includes('operator-only'), 'session-required-scan', `${rel} never mentions 'operator-only' — one file defines the prefix, the other must act on it`);
    }
  }

  // --- Repository map covers the real tree, both directions. Root-level files are covered
  // by "Placements that cannot move" prose instead, not a row. pin: `ARCHITECTURE.md`'s map ↔ the real tree
  {
    const rel = 'ARCHITECTURE.md';
    const text = readFileSync(join(root, rel), 'utf8');
    const lines = text.split('\n');

    // Locate the table under its fixed heading, never by line number — the map will grow rows and a positional parser would break on the first edit.
    const headingIdx = lines.findIndex((l) => l.trim() === '## Map');
    const rows = [];
    if (headingIdx === -1) {
      fail('architecture-map', `${rel} no longer has a '## Map' heading for the repository map table`);
    } else {
      for (let i = headingIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        if (/^##\s/.test(line)) break; // next section — table ended
        const m = /^\|\s*`([^`]+)`\s*\|.*\|\s*([^|]*)\|\s*$/.exec(line);
        if (m) rows.push({ path: m[1], ships: m[2].trim() });
      }
    }

    if (rows.length === 0) {
      fail('architecture-map', `${rel}: the '## Map' table parsed 0 rows — the parser or the table itself has broken`);
    } else {
      note(`architecture-map: ${rows.length} rows parsed`);
      ok();
    }

    // 1. Every path the map names must exist on disk.
    for (const { path } of rows) {
      expect(existsSync(join(root, path)), 'architecture-map', `${rel}: row '${path}' does not exist on disk`);
    }

    // 2. Every tracked top-level directory is covered by at least one row. Fails open (a
    // note) if git ls-files is unavailable — a git-less environment must not block every unrelated pull request.
    let lsFiles;
    try {
      lsFiles = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
    } catch (e) {
      note(`architecture-map: 'git ls-files' unavailable (${message(e)}) — skipping directory-coverage check`);
      lsFiles = null;
    }
    if (lsFiles !== null) {
      const topDirs = new Set();
      for (const entry of lsFiles.split('\0')) {
        const slash = entry.indexOf('/');
        if (slash !== -1) topDirs.add(entry.slice(0, slash));
      }
      for (const dir of topDirs) {
        const covered = rows.some(({ path }) => path === `${dir}/` || path.startsWith(`${dir}/`));
        expect(covered, 'architecture-map', `${rel}: top-level directory '${dir}/' is not covered by any row`);
      }
    }

    // 3. Every row's Ships cell is exactly 'yes' or 'no' — a blank or hedged cell silently drops the principle the map exists to state.
    for (const { path, ships } of rows) {
      expect(!(ships !== 'yes' && ships !== 'no'), 'architecture-map', `${rel}: row '${path}' has Ships cell ${JSON.stringify(ships)} — must be exactly 'yes' or 'no'`);
    }
  }

  // --- ENGINEERING.md's Module boundaries stay in ascending path order — every paragraph
  // opens with a bolded backticked path, so two tickets adding one each land at different offsets for git to merge both. ---
  {
    /** Extracts the ordered list of paths each paragraph opens with — the first backticked
     *  token inside its leading bold span. Pure, so a self-test can exercise it directly. */
    function boundaryPaths(section: string): string[] {
      const paragraphs = section.split(/\n\n+/).filter((p) => p.trim().startsWith('**'));
      const paths: string[] = [];
      for (const p of paragraphs) {
        const boldSpan = /^\*\*(.*?)\*\*/s.exec(p.trim());
        const pathMatch = boldSpan && /`([^`]+)`/.exec(boldSpan[1]);
        if (pathMatch) paths.push(pathMatch[1]);
      }
      return paths;
    }

    // Self-test first — three paragraphs, deliberately out of order.
    const fixture = [
      '**`b/two` does the second thing.**',
      '**`a/one` does the first thing.**',
      '**`c/three` does the third thing.**',
    ].join('\n\n');
    const fixturePaths = boundaryPaths(fixture);
    const fixtureSorted = [...fixturePaths].sort();
    expect(!(fixturePaths.length !== 3 || JSON.stringify(fixturePaths) === JSON.stringify(fixtureSorted)), 'engineering-module-boundaries', 'boundaryPaths self-test: a deliberately out-of-order fixture parsed as already sorted, or lost an entry');

    const rel = 'docs/ENGINEERING.md';
    const text = readFileSync(join(root, rel), 'utf8');
    const sectionMatch = /### Module boundaries\n([\s\S]*?)(?=\n## |$)/.exec(text);
    if (!sectionMatch) {
      fail('engineering-module-boundaries', `${rel} has no '### Module boundaries' subsection`);
    } else {
      const paths = boundaryPaths(sectionMatch[1]);
      if (paths.length === 0) {
        fail('engineering-module-boundaries', `${rel}'s '### Module boundaries' subsection parsed 0 paragraphs — the parser or the subsection itself has broken`);
      } else {
        note(`engineering-module-boundaries: ${paths.length} paragraphs parsed`);
        ok();
        for (let i = 1; i < paths.length; i++) {
          expect(!(paths[i - 1] > paths[i]), 'engineering-module-boundaries', `${rel}: '### Module boundaries' is out of order — '${paths[i - 1]}' appears before '${paths[i]}'`);
        }
      }
    }
  }
}
