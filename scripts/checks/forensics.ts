import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, readJson, walk, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

const FORENSICS_DIR = 'scripts/port-forensics';
const CLI_REL = 'scripts/port-forensics.ts';
const TRANSCRIPT_REL = 'scripts/lib/transcript.ts';

async function importEngine(rel: string): Promise<any> {
  return import(pathToFileURL(join(root, rel)).href);
}

function stripComments(text: string): string {
  return text
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
}

/** Every function name a decision-case table names, run against `impl` with the calling
 *  convention this table's own file fixes per function. */
function runCases(table: any, engine: any, callConventions: Record<string, boolean>, expect: Reporter['expect'], fail: Reporter['fail'], tableRel: string): void {
  for (const c of table.cases) {
    const impl = engine[c.function];
    if (!impl) {
      fail('forensics-cases', `${tableRel} — '${c.name}': names unknown function '${c.function}'`);
      continue;
    }
    const spread = callConventions[c.function];
    const got = spread ? impl(...c.input) : impl(c.input);
    const gotStr = JSON.stringify(got === undefined ? null : got);
    const expStr = JSON.stringify(c.expected === undefined ? null : c.expected);
    expect(!(gotStr !== expStr), 'forensics-cases', `${tableRel} — '${c.name}': expected ${expStr}, got ${gotStr}`);
  }
}

export default async function ({ expect, fail, note, ok }: Reporter) {
  const transcript = await importEngine(TRANSCRIPT_REL);
  const classify = await importEngine(`${FORENSICS_DIR}/classify.ts`);

  // --- (1) Every case in both decision tables resolves and passes, so a second implementation never silently diverges from the engine's recorded behaviour. ---
  {
    const transcriptTable = readJson(`${FORENSICS_DIR}/cases/transcript.cases.json`);
    runCases(
      transcriptTable,
      transcript,
      { excerpt: true }, // every other transcript.ts case passes its input as the one positional arg
      expect,
      fail,
      `${FORENSICS_DIR}/cases/transcript.cases.json`,
    );

    const classifyTable = readJson(`${FORENSICS_DIR}/cases/classify.cases.json`);
    const spreadEverything = Object.fromEntries(
      ['classifyTermination', 'notificationGaps', 'orphans', 'shellLoopHits', 'bashTimeouts', 'blockedAfterDenial', 'quotaClass', 'usesShellLoop', 'targetsGhOrGit', 'stageOf', 'itemNumberOf'].map((f) => [f, true]),
    );
    runCases(classifyTable, classify, spreadEverything, expect, fail, `${FORENSICS_DIR}/cases/classify.cases.json`);

    note(`forensics: ${transcriptTable.cases.length} transcript.ts cases, ${classifyTable.cases.length} classify.ts cases`);
  }

  // --- (1b) sanitize strips a C0 control character — JSON cannot hold a raw byte unescaped, so this case is asserted directly rather than via the shared table. ---
  {
    const withControl = `a${String.fromCharCode(7)}b`;
    expect(!(transcript.sanitize(withControl) !== 'ab'), 'forensics-cases', 'sanitize did not strip a C0 control character (0x07)');
  }

  // --- (1c) The shared record-classification table also passes against scripts/lib/
  // transcript.ts, so it never silently drifts from the desktop app's own deriver. ---
  {
    const sharedTableRel = 'apps/desktop/src/main/sessions/transcript.cases.json';
    const sharedTable = readJson(sharedTableRel);
    for (const c of sharedTable.cases) {
      const records = c.pushes.flat();
      const { emitted, paired } = transcript.deriveEvents(records);
      const gotEmitted = emitted.map((e: any) => (e.kind === 'tool-call' ? { kind: e.kind, name: e.name } : e.kind === 'meta' ? { kind: e.kind } : { kind: e.kind, text: e.text }));
      const gotPaired = paired.map((p: any) => ({ index: p.index, isError: p.isError, text: p.text }));
      const gotStr = JSON.stringify({ emitted: gotEmitted, paired: gotPaired });
      const expStr = JSON.stringify(c.expect);
      expect(!(gotStr !== expStr), 'forensics-shared-table', `${sharedTableRel} — '${c.name}': scripts/lib/transcript.ts produced ${gotStr}, expected ${expStr}`);
    }
  }

  // --- (2) usesShellLoop/targetsGhOrGit pinned against the guard hook's own originals, both
  // directions, so a command the hook would flag never stops being detected here. ---
  {
    const original = await importEngine('plugins/port/hooks/lib/command-rules.mjs');
    const battery = [
      'for n in 1 2; do gh issue edit $n --add-label x; done',
      'while read n; do git push origin "$n"; done',
      'gh issue comment -b "a loop for each item to do"',
      'gh issue list',
      'wc -l file.txt',
      'for f in *.txt; do wc -l "$f"; done',
      'git status',
      'echo hi',
    ];
    for (const cmd of battery) {
      const loopMatch = classify.usesShellLoop(cmd) === original.usesShellLoop(cmd);
      const targetMatch = classify.targetsGhOrGit(cmd) === original.targetsGhOrGit(cmd);
      expect(loopMatch, 'forensics-shell-rules', `usesShellLoop disagrees between classify.ts and command-rules.mjs for ${JSON.stringify(cmd)}`);
      expect(targetMatch, 'forensics-shell-rules', `targetsGhOrGit disagrees between classify.ts and command-rules.mjs for ${JSON.stringify(cmd)}`);
    }
  }

  // --- (3) STAGE_AGENTS pinned against plugins/port/agents/'s real basenames and apps/
  // desktop's own PORT_STAGE_AGENTS, both directions, so a finding's stage is never mis-attributed. ---
  {
    const agentBasenames = new Set(readdirSync(join(root, 'plugins/port/agents')).filter((f) => f.endsWith('.md')).map((f) => basename(f, '.md')));
    const engineSet = new Set<string>(classify.STAGE_AGENTS);
    for (const name of agentBasenames) {
      expect(engineSet.has(name), 'forensics-stages', `plugins/port/agents/${name}.md exists, but classify.ts's STAGE_AGENTS does not name '${name}'`);
    }
    for (const name of engineSet) {
      expect(agentBasenames.has(name), 'forensics-stages', `classify.ts's STAGE_AGENTS names '${name}', which plugins/port/agents/ does not carry`);
    }

    const desktopRel = 'apps/desktop/src/main/sessions/classify.ts';
    const desktopText = readFileSync(join(root, desktopRel), 'utf8');
    const m = /PORT_STAGE_AGENTS[^=]*=\s*\[([^\]]*)\]/.exec(desktopText);
    if (!m) {
      fail('forensics-stages', `${desktopRel} has no 'PORT_STAGE_AGENTS = [...]' to read`);
    } else {
      const desktopStages = new Set([...m[1].matchAll(/'([^']+)'/g)].map((mm) => mm[1]));
      for (const name of engineSet) {
        expect(desktopStages.has(name), 'forensics-stages', `classify.ts's STAGE_AGENTS names '${name}', which ${desktopRel}'s PORT_STAGE_AGENTS does not`);
      }
      for (const name of desktopStages) {
        expect(engineSet.has(name), 'forensics-stages', `${desktopRel}'s PORT_STAGE_AGENTS names '${name}', which classify.ts's STAGE_AGENTS does not`);
      }
    }
  }

  // --- (4) Read-only, no busy child process, no whole-transcript mode — the engine must
  // never gain a write path, a filtered GraphQL read, a second spawn, or an inlined transcript flag. ---
  {
    const files = [join(root, CLI_REL), join(root, TRANSCRIPT_REL), ...walk(join(root, FORENSICS_DIR)).filter((f) => f.endsWith('.ts'))];
    const spawnRe = /\b(?:spawnSync|spawn|execFileSync|execFile|execSync|exec)\(\s*['"](\w+)['"]/g;
    for (const f of files) {
      const text = stripComments(readFileSync(f, 'utf8'));
      const rel = relOf(f);

      let match;
      spawnRe.lastIndex = 0;
      while ((match = spawnRe.exec(text))) {
        const bin = match[1];
        // 'git' is fine anywhere; 'gh' is fine only in scripts/port-tick/gh.ts, which this walk never includes.
        if (bin === 'git') continue;
        fail('forensics-io', `${rel} spawns '${bin}' directly — every GitHub read must go through the reused scripts/port-tick/gh.ts, and nothing else may shell out`);
      }
      ok();

      expect(!/--jq\b/.test(text), 'forensics-io', `${rel} uses --jq — the GraphQL call must always be parsed in full, never filtered`);
      expect(!/shell:\s*true/.test(text), 'forensics-io', `${rel} passes shell: true to a child process`);
      expect(!(/\bgh (issue|pr|label) (edit|comment|create|merge|close)\b/.test(text) || /--add-label\b|--remove-label\b/.test(text)), 'forensics-io', `${rel} spells out a mutating 'gh' subcommand or label-write flag literal — this engine is read-only, with no write path at all`);
      // A whole-transcript dump: any flag literal that looks like printing raw records instead of findings.
      expect(!/--dump\b|--raw\b|--full\b/.test(text), 'forensics-io', `${rel} names a flag that reads like a whole-transcript dump — the CLI has no such mode`);
    }
  }

  // --- (5) excerpt is the one chokepoint for transcript-derived text — nothing outside
  // scripts/lib/transcript.ts may reimplement the control/bidi sanitizer. ---
  {
    const files = walk(join(root, FORENSICS_DIR)).filter((f) => f.endsWith('.ts'));
    for (const f of files) {
      const rel = relOf(f);
      const text = stripComments(readFileSync(f, 'utf8'));
      expect(!/0x00|0x1f|0x7f|202a|2066/.test(text), 'forensics-excerpt', `${rel} appears to reimplement sanitize's control/bidi ranges — every sanitizer lives in ${TRANSCRIPT_REL} alone`);
    }
  }

  // --- (6) No running/alive/isLive identifier — recency must never read as liveness. Scoped
  // to identifiers, never string literals: 'running' is a real task_status.status value. ---
  {
    const files = [join(root, CLI_REL), join(root, TRANSCRIPT_REL), ...walk(join(root, FORENSICS_DIR)).filter((f) => f.endsWith('.ts'))];
    const identifierRe = /\b(?:const|let|var|function)\s+(running|isLive|alive)\b|\.(running|isLive|alive)\s*=/;
    for (const f of files) {
      const text = stripComments(readFileSync(f, 'utf8'));
      expect(!identifierRe.test(text), 'forensics-liveness', `${relOf(f)} declares a 'running'/'isLive'/'alive'-named identifier — a transcript's recency is never liveness`);
    }
  }

  // --- (7) commands.forensics never enters commands.checks — it reads a machine-local path
  // outside the repository and shells out to gh, meaningless in CI. ---
  {
    for (const rel of ['.claude/port.config.json', 'plugins/port/templates/port.config.json']) {
      const cfg = readJson(rel);
      for (const entry of cfg.commands?.checks ?? []) {
        for (const cmd of [entry?.run, entry?.fix]) {
          if (typeof cmd === 'string' && /port-forensics/.test(cmd)) {
            fail('forensics-scope', `${rel} runs the forensics engine from commands.checks (${JSON.stringify(cmd)})`);
          }
        }
      }
    }
    ok();
  }

  // --- (7b) schema/template both carry commands.forensics, defaulting null, so the key never lands in one and not the other. ---
  {
    const schema = readJson('schema/port.config.schema.json');
    const forensicsSchema = schema.properties?.commands?.properties?.forensics;
    expect(!(!forensicsSchema || JSON.stringify(forensicsSchema.type) !== JSON.stringify(['string', 'null']) || forensicsSchema.default !== null), 'forensics-scope', "schema/port.config.schema.json's commands.forensics must be type ['string','null'] with default null");
    const template = readJson('plugins/port/templates/port.config.json');
    expect(!(template.commands?.forensics !== null), 'forensics-scope', `plugins/port/templates/port.config.json's commands.forensics must be null, got ${JSON.stringify(template.commands?.forensics)}`);
  }

  // --- (7c) No hardcoded ~/.claude — must always resolve via CLAUDE_CONFIG_DIR, never break for an operator whose home is elsewhere. ---
  {
    const text = stripComments(readFileSync(join(root, FORENSICS_DIR, 'scan.ts'), 'utf8'));
    expect(!/['"]~\/\.claude['"]/.test(text), 'forensics-scope', 'scan.ts hardcodes a literal ~/.claude path — the Claude home must be resolved via CLAUDE_CONFIG_DIR then os.homedir()');
  }

  // --- (8) The fixture tree exercises scan.ts's resolve and degrade paths — absent or
  // unreadable session directories must degrade to one clear line, never a stack trace. ---
  {
    const scan = await importEngine(`${FORENSICS_DIR}/scan.ts`);
    const fixtureHome = join(root, FORENSICS_DIR, 'fixtures');

    const index = scan.buildProjectIndex(fixtureHome);
    if (!index.ok) {
      fail('forensics-fixtures', `scan.ts's buildProjectIndex could not read the fixture tree: ${index.message}`);
    } else {
      const ids = scan.listSessionIds(index.index);
      if (ids.length !== 1) {
        fail('forensics-fixtures', `expected exactly 1 fixture session, found ${ids.length}`);
      } else {
        const session = scan.readSession(ids[0], index.index.get(ids[0]));
        expect(!(session.malformed !== 1), 'forensics-fixtures', `expected 1 malformed line in the fixture session, got ${session.malformed}`);
        if (session.agents.length !== 1) {
          fail('forensics-fixtures', `expected 1 readable agent transcript (the malformed-meta sidecar must degrade, not crash), got ${session.agents.length}`);
        } else {
          ok();
          const term = classify.classifyTermination(session.agents[0].records);
          expect(!(term.class !== 'terminal'), 'forensics-fixtures', `expected the fixture agent to classify 'terminal', got '${term.class}'`);
        }
        expect(!(session.problems.length === 0), 'forensics-fixtures', 'expected at least one degraded problem (the malformed-meta sidecar) in the fixture session, got none');
      }
    }

    // Absent tree: a directory that does not exist degrades to a named result, never a thrown error.
    const missing = scan.buildProjectIndex(join(root, FORENSICS_DIR, 'fixtures-does-not-exist'));
    expect(!(missing.ok || missing.kind !== 'claude-home-missing'), 'forensics-fixtures', `buildProjectIndex over an absent tree must report 'claude-home-missing', got ${JSON.stringify(missing)}`);
  }

  // --- (9) report.ts's own orchestration runs end to end, without a `gh` call, catching a
  // wiring bug no per-function case table can see. No `args.repoRoot` is passed, so the orphan assertion degrades to "not computable" rather than shelling out. ---
  {
    const reportMod = await importEngine(`${FORENSICS_DIR}/report.ts`);
    const fixtureHome = join(root, FORENSICS_DIR, 'fixtures');

    try {
      const result = reportMod.runReport({ claudeHome: fixtureHome });
      if (![0, 1].includes(result.exitCode)) {
        fail('forensics-report', `runReport over the fixture tree returned exitCode ${result.exitCode}, expected 0 or 1`);
      } else expect(!(result.notes.length === 0), 'forensics-report', 'runReport over the fixture tree produced no notes at all');
      const text = reportMod.renderText(result);
      const jsonBody = reportMod.renderJson(result);
      expect(!(typeof text !== 'string' || text.length === 0), 'forensics-report', 'renderText produced no text');
      expect(!(!Array.isArray(jsonBody.notes) || !Array.isArray(jsonBody.findings)), 'forensics-report', 'renderJson did not produce { notes, findings } arrays');
    } catch (e: any) {
      fail('forensics-report', `runReport threw over the fixture tree: ${e?.message ?? e}`);
    }

    try {
      const missingResult = reportMod.runReport({ claudeHome: join(root, FORENSICS_DIR, 'fixtures-does-not-exist') });
      expect(!(missingResult.exitCode !== 2), 'forensics-report', `runReport over an absent claude-home must exit 2, got ${missingResult.exitCode}`);
    } catch (e: any) {
      fail('forensics-report', `runReport threw over an absent claude-home instead of degrading: ${e?.message ?? e}`);
    }

    try {
      const invalidSession = reportMod.runReport({ claudeHome: fixtureHome, session: 'not-a-uuid' });
      expect(!(invalidSession.exitCode !== 1), 'forensics-report', `runReport with an invalid --session must exit 1, got ${invalidSession.exitCode}`);
      const invalidSince = reportMod.runReport({ claudeHome: fixtureHome, since: 'yesterday' });
      expect(!(invalidSince.exitCode !== 1), 'forensics-report', `runReport with an unparseable --since must exit 1, got ${invalidSince.exitCode}`);
    } catch (e: any) {
      fail('forensics-report', `runReport threw on a malformed argument instead of exiting 1: ${e?.message ?? e}`);
    }

    // A --since past every record in the fixture tree matches no session —
    // reported as a note, exit 0, distinguished from "read nothing".
    try {
      const noneMatched = reportMod.runReport({ claudeHome: fixtureHome, since: '2099-01-01T00:00:00.000Z' });
      expect(!(noneMatched.exitCode !== 0 || noneMatched.findings.length !== 0 || !noneMatched.notes.some((n: string) => n.includes('0 sessions matched'))), 'forensics-report', `runReport with a --since matching no session must exit 0 with a '0 sessions matched' note, got ${JSON.stringify(noneMatched)}`);
    } catch (e: any) {
      fail('forensics-report', `runReport threw on a --since matching no session: ${e?.message ?? e}`);
    }
  }
}
