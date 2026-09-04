import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf } from '../lib/files.mjs';

// A pure hyphenation or spacing mutation of the marker (e.g. `SESSION-REQUIRED`)
// drops the two-word substring the scans below key on, so it slips through
// unnoticed there. This is also what pins PIPELINE.md's own canonical example
// to the exact form every other file's example is meant to match.
const SESSION_MARKER_LINE = /^>\s*\*\*SESSION REQUIRED:\*\*\s+\S/;

export default async function ({ fail, note, ok }) {
  // --- Stale references -------------------------------------------------------
  // Each of these named something real that was renamed or moved.
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

    const banned = [
      [/\bport-init\b/, 'the installer skill is `init`, invoked as /port:init'],
      [
        /`port\.config\.json`/,
        'the config lives at `.claude/port.config.json`',
        // /port:init's migration step names the legacy root location on purpose —
        // it is the one place that acts on it. Any other bare mention is stale.
        (line) => line.includes('repository root'),
      ],
      [/(^|[^:\w/])\/(pipeline|scope|implement|release|worktree-clean|analyze|init)\b/, 'skill references need the `port:` prefix'],
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

  // --- SESSION REQUIRED never rendered as a bare, uncoded marker line --------
  // Regression guard for #156: the cockpit's consumer check used to be a bare
  // substring search over the whole body, so any prompt file merely
  // *discussing* the marker in prose false-positived. This is the producer-side
  // mechanical half: every `SESSION REQUIRED` mention across the same doc set
  // "Stale references" scans is either inside backticks or is the canonical
  // `> **SESSION REQUIRED:** <reason>` rendering at line start — a reworded or
  // unrendered marker fails here, in CI, rather than silently at dispatch time.
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
      // Skip YAML frontmatter — a skill's `description:` line may name the
      // marker bare (implement/SKILL.md's does), and no frontmatter value uses
      // backticks.
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
      } else if (!SESSION_MARKER_LINE.test(fileLines[exampleIdx].trim())) {
        fail(
          'session-required-rendering',
          `${rel}:${exampleIdx + 1}: canonical marker example is not '> **SESSION REQUIRED:** <reason>', got ${JSON.stringify(fileLines[exampleIdx].trim())}`,
        );
      } else {
        ok();
      }
    }
  }

  // --- Session-required determination reads the whole plan, not just changes -
  // Regression guard for #118: the determination looked only at the changed-file
  // list, so a plan whose testing steps needed a sessionRequiredPaths write (but
  // whose deliverables did not) was declared plainly dispatchable, and the
  // dispatched agent died on the permission prompt.
  {
    const planAgent = readFileSync(join(root, 'plugins/port/agents/plan-agent.md'), 'utf8');
    const implAgent = readFileSync(join(root, 'plugins/port/agents/impl-agent.md'), 'utf8');

    const start = planAgent.indexOf('**Session-required declaration.**');
    if (start === -1) {
      fail('session-required-scan', 'plugins/port/agents/plan-agent.md has no "Session-required declaration" section');
    } else {
      const rest = planAgent.slice(start);
      // Scope tightly to the declaration's determination paragraph — stop at the
      // first blank line, not the next `## ` heading. The old bound ran all the
      // way to `## Handoff`, which also swallows the later "Human-runnable
      // manual steps ... in `## Testing`" bullet under "Use the fixed
      // structure", so a real deletion of the `## Testing` reference from the
      // determination sentence went undetected (R1-C1).
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
      if (!text.includes('operator-only')) {
        fail('session-required-scan', `${rel} never mentions 'operator-only' — one file defines the prefix, the other must act on it`);
      } else {
        ok();
      }
    }
  }

  // --- Repository map covers the real tree, both directions ------------------
  // ARCHITECTURE.md (#167) is prose that goes stale silently, so it is pinned
  // to the real tree in both directions: every path it names must still exist,
  // and every tracked top-level directory must be named by at least one row.
  // Root-level *files* are deliberately outside this mechanical set — they are
  // covered by the "Placements that cannot move" prose instead, not by a row —
  // so the coverage check below only ever looks at directories.
  {
    const rel = 'ARCHITECTURE.md';
    const text = readFileSync(join(root, rel), 'utf8');
    const lines = text.split('\n');

    // Locate the table under its fixed heading, never by line number — the
    // map will grow rows (#171 splits templates/) and a positional parser
    // would break on the first edit.
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
      if (!existsSync(join(root, path))) {
        fail('architecture-map', `${rel}: row '${path}' does not exist on disk`);
      } else {
        ok();
      }
    }

    // 2. Every tracked top-level directory is covered by at least one row.
    // Fails open (a note, not a fail) if git ls-files is unavailable — a stale
    // map is a documentation defect a reviewer still catches, while a hard
    // failure in a git-less environment would block every unrelated pull
    // request.
    let lsFiles;
    try {
      lsFiles = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
    } catch (e) {
      note(`architecture-map: 'git ls-files' unavailable (${e.message}) — skipping directory-coverage check`);
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
        if (!covered) {
          fail('architecture-map', `${rel}: top-level directory '${dir}/' is not covered by any row`);
        } else {
          ok();
        }
      }
    }

    // 3. Every row's Ships cell is exactly 'yes' or 'no' — the column is the
    // load-bearing part of the map, so a blank or hedged cell silently drops
    // the principle the map exists to state.
    for (const { path, ships } of rows) {
      if (ships !== 'yes' && ships !== 'no') {
        fail('architecture-map', `${rel}: row '${path}' has Ships cell ${JSON.stringify(ships)} — must be exactly 'yes' or 'no'`);
      } else {
        ok();
      }
    }
  }
}
