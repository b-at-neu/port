import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf, frontmatter } from '../lib/files.mjs';

// --- Shell-discipline block stays byte-identical everywhere it fires -------
// Regression guard: the Bash hygiene rules drifted between agents because
// they were copied by hand. The canonical text lives once in PIPELINE.md
// between marker comments; every agent granting Bash must carry an exact
// copy, or the rules it actually has in context can silently fall behind the
// ones it was reviewed against.
export default async function ({ fail, note, ok }) {
  const BEGIN = '<!-- shell-discipline:begin -->';
  const END = '<!-- shell-discipline:end -->';
  const extractBlock = (text) => {
    const beginIdx = text.indexOf(BEGIN);
    const endIdx = text.indexOf(END);
    if (beginIdx === -1 || endIdx === -1) return null;
    return text.slice(beginIdx + BEGIN.length, endIdx).trim();
  };

  const pipelineRel = 'plugins/port/docs/PIPELINE.md';
  const canonical = extractBlock(readFileSync(join(root, pipelineRel), 'utf8'));
  if (canonical === null) {
    fail('shell-discipline', `canonical shell-discipline block missing from ${pipelineRel}`);
  } else {
    ok();
  }

  const agentFiles = walk(join(root, 'plugins/port/agents')).filter((f) => f.endsWith('.md'));
  let matched = 0;
  for (const f of agentFiles) {
    const rel = relOf(f);
    const fm = frontmatter(f) ?? {};
    const grantsBash =
      fm.tools === undefined || fm.tools.split(',').map((t) => t.trim()).includes('Bash');
    if (!grantsBash) continue;
    matched++;

    const block = extractBlock(readFileSync(f, 'utf8'));
    if (block === null) {
      fail('shell-discipline', `${rel} grants Bash but is missing the shell-discipline markers`);
    } else if (canonical === null) {
      note(`${rel}: skipped comparison — no canonical block to compare against`);
    } else if (block !== canonical) {
      fail('shell-discipline', `${rel}'s shell-discipline block has drifted from ${pipelineRel}'s canonical text`);
    } else {
      ok();
    }
  }
  if (matched < 4) {
    fail('shell-discipline', `only ${matched} agent(s) granting Bash matched under plugins/port/agents — expected at least 4`);
  } else {
    ok();
  }
}
