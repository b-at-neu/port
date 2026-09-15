// Parses `guard(#N, ...): <description>` / `guard: <description>` markers out
// of a check module's comments, and renders the layer 1 guard index from
// them — the mechanism that replaces docs/TESTING.md's single hub-file table
// (#217). Dependency-free and read-only: nothing here touches the
// filesystem, so both scripts/checks/guards.mjs (validation) and
// scripts/checks.mjs --guards (rendering) call the same two functions rather
// than keeping two parsers in sync.

// Trailing-dash count varies across this codebase's existing `// --- title
// ---` headers — some run to a fixed column, some end after one dash, and a
// long title runs the line out with none at all — so the trailing dashes
// are optional, never `{2,}` or even `+`, or a real header would go
// unrecognized and silently attach its marker to whatever title preceded it.
const HEADER_RE = /^\/\/\s*---\s*(.+?)\s*-*\s*$/;
const GUARD_RE = /^\/\/\s*guard(\([^)]*\))?:\s*(.*)$/;
const ISSUE_LIST_RE = /^#\d+(?:,\s*#\d+)*$/;

/** Parses every `guard(...)`/`guard:` marker in `text`, one check module's
 *  source. A marker attaches to the nearest preceding `// --- <title> ---`
 *  header, taking that header's title with trailing dashes already trimmed
 *  by the regex above; a marker with no preceding header attaches to the
 *  module itself, titled `moduleName`. A marker's description is not just
 *  its own physical line — this codebase's normal prose style wraps a
 *  marker's description across several `//` lines, so parsing continues
 *  onto each subsequent `//` line, joined with a single space, until a
 *  blank line, a `// --- title ---` header, the next `guard(...)`/`guard:`
 *  marker, or a non-comment line ends the block. Returns entries in source
 *  order, each `{ module, title, issues, issuesRaw, description }` —
 *  `issues` is an array of numbers, or `null` when the parenthesized list
 *  does not parse as `#N[, #N...]`; `issuesRaw` is the untouched
 *  parenthetical content for a malformed list, or `null` when the marker
 *  declared no parentheses at all (the `guard: <description>` form);
 *  `description` is the trimmed, joined rest of the block, empty when the
 *  marker states none. */
export function parseModule(text, moduleName) {
  const entries = [];
  let title = moduleName;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const header = HEADER_RE.exec(line);
    if (header) {
      title = header[1];
      continue;
    }
    const guard = GUARD_RE.exec(line);
    if (!guard) continue;
    const [, parenRaw, descriptionRaw] = guard;
    const descriptionParts = [descriptionRaw.trim()];
    let next = i + 1;
    for (; next < lines.length; next++) {
      const continuation = lines[next].trim();
      if (continuation === '' || HEADER_RE.test(continuation) || GUARD_RE.test(continuation)) break;
      const commentMatch = /^\/\/\s?(.*)$/.exec(continuation);
      if (!commentMatch) break;
      descriptionParts.push(commentMatch[1].trim());
    }
    i = next - 1;
    const description = descriptionParts.join(' ').trim();
    let issues = [];
    let issuesRaw = null;
    if (parenRaw !== undefined) {
      issuesRaw = parenRaw.slice(1, -1).trim();
      issues = ISSUE_LIST_RE.test(issuesRaw)
        ? [...issuesRaw.matchAll(/#(\d+)/g)].map((m) => Number(m[1]))
        : null;
    }
    entries.push({ module: moduleName, title, issues, issuesRaw, description });
  }
  return entries;
}

/** Renders the whole guard index as plain markdown and nothing else: a
 *  `## Layer 1 guard index` heading, a one-sentence count, then one
 *  `### <module>` section per module — in the order each first appears in
 *  `entries`, which is filename order when the caller fed files in that
 *  order — holding a `| Check | Guards against | Issue |` table in source
 *  order. The issue cell lists every `#N` the entry declares, comma
 *  separated, or is empty when it declares none or its list is malformed. */
export function renderIndex(entries) {
  const modules = [];
  for (const e of entries) if (!modules.includes(e.module)) modules.push(e.module);

  const lines = [
    '## Layer 1 guard index',
    '',
    `${entries.length} guards across ${modules.length} modules.`,
  ];
  for (const mod of modules) {
    lines.push('', `### ${mod}`, '', '| Check | Guards against | Issue |', '| --- | --- | --- |');
    for (const e of entries.filter((x) => x.module === mod)) {
      const issueCell = e.issues ? e.issues.map((n) => `#${n}`).join(', ') : '';
      lines.push(`| ${e.title} | ${e.description} | ${issueCell} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}
