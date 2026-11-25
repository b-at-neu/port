import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '#lib/files.ts';
import type { Reporter } from '#lib/report.ts';

// --- A stage agent that rereads its own definition and config was dispatched without its context: every agent carries the byte-identical "Dispatched with a stage context" rule. ---
export default async function ({ expect }: Reporter) {
  const STAGES = ['plan', 'impl', 'review', 'revise'];
  const RULE_START = '**Dispatched with a stage context.**';
  const paragraphOf = (text: string): string | null => {
    const start = text.indexOf(RULE_START);
    if (start === -1) return null;
    const end = text.indexOf('\n', start);
    return text.slice(start, end === -1 ? undefined : end);
  };

  const paragraphs = new Map<string, string | null>();
  for (const stage of STAGES) {
    const rel = `plugins/port/agents/${stage}-agent.md`;
    paragraphs.set(rel, paragraphOf(readFileSync(join(root, rel), 'utf8')));
  }

  const canonical = paragraphs.get('plugins/port/agents/impl-agent.md') ?? null;
  expect(canonical !== null, 'stage-context', 'impl-agent.md carries no "Dispatched with a stage context" rule');
  for (const [rel, paragraph] of paragraphs) {
    expect(paragraph !== null && paragraph === canonical, 'stage-context', `${rel}'s "Dispatched with a stage context" rule is missing or has drifted from impl-agent.md's copy`);
  }

  // The load-bearing literals: the block tags, the `repo:` discriminator, and the read-config fallback.
  const required = ['<port-stage-context>', '`repo:`', '<port-stage-instructions>', 'Without a `repo:` line, read the configuration as below.'];
  for (const literal of required) {
    expect(canonical?.includes(literal) === true, 'stage-context', `the stage-context rule no longer names ${literal}`);
  }

  // Self-test: a drifted copy must not equal the canonical text.
  const drifted = canonical?.replace('already resolved', 'resolved') ?? '';
  expect(drifted !== canonical, 'stage-context', 'self-test: a reworded rule compared equal to the canonical text');
}
