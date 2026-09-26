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

/** Every function name a decision-case table names, run against `impl` with
 *  the calling convention this table's own file fixes per function — the
 *  same "a case names its function, the runner knows how to call it" shape
 *  scripts/checks/tick.ts uses. */
function runCases(table: any, engine: any, callConventions: Record<string, boolean>, fail: Reporter['fail'], ok: Reporter['ok'], tableRel: string): void {
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
    if (gotStr !== expStr) {
      fail('forensics-cases', `${tableRel} — '${c.name}': expected ${expStr}, got ${gotStr}`);
    } else {
      ok();
    }
  }
}

export default async function ({ fail, note, ok }: Reporter) {
  const transcript = await importEngine(TRANSCRIPT_REL);
  const classify = await importEngine(`${FORENSICS_DIR}/classify.ts`);

  // --- (1) Every case in both decision tables resolves and passes ------------
  // guard(#123): a second implementation (this module's own pin below, and
  // any future one) silently diverging from the engine's recorded behaviour,
  // the same "cases-table pinning" rail scripts/checks/tick.ts holds for
  // the tick engine — mirrored here per the plan's own "Shape and rails
  // follow the tick engine exactly".
  {
    const transcriptTable = readJson(`${FORENSICS_DIR}/cases/transcript.cases.json`);
    runCases(
      transcriptTable,
      transcript,
      { excerpt: true }, // every other transcript.ts case passes its input as the one positional arg
      fail,
      ok,
      `${FORENSICS_DIR}/cases/transcript.cases.json`,
    );

    const classifyTable = readJson(`${FORENSICS_DIR}/cases/classify.cases.json`);
    const spreadEverything = Object.fromEntries(
      ['classifyTermination', 'notificationGaps', 'orphans', 'shellLoopHits', 'bashTimeouts', 'blockedAfterDenial', 'quotaClass', 'usesShellLoop', 'targetsGhOrGit', 'stageOf', 'itemNumberOf'].map((f) => [f, true]),
    );
    runCases(classifyTable, classify, spreadEverything, fail, ok, `${FORENSICS_DIR}/cases/classify.cases.json`);

    note(`forensics: ${transcriptTable.cases.length} transcript.ts cases, ${classifyTable.cases.length} classify.ts cases`);
  }

  // --- (1b) sanitize strips a C0 control character -----------------------------
  // guard(#123): a JSON case table cannot hold a raw U+0000-U+001F byte
  // (JSON itself forbids it unescaped), so this one case is asserted
  // directly rather than via the shared table.
  {
    const withControl = `a${String.fromCharCode(7)}b`;
    if (transcript.sanitize(withControl) !== 'ab') {
      fail('forensics-cases', 'sanitize did not strip a C0 control character (0x07)');
    } else {
      ok();
    }
  }

  // --- (1c) The shared record-classification table also passes against
  // scripts/lib/transcript.ts — the other half of the "two readers, one
  // contract" pin, whose desktop half apps/desktop's own
  // transcript-entries.test.ts asserts ---------------------------------------
  // guard(#123): scripts/'s reader silently drifting from the desktop app's
  // deriver on the record-classification/pairing slice both must agree on.
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
      if (gotStr !== expStr) {
        fail('forensics-shared-table', `${sharedTableRel} — '${c.name}': scripts/lib/transcript.ts produced ${gotStr}, expected ${expStr}`);
      } else {
        ok();
      }
    }
  }

  // --- (2) usesShellLoop/targetsGhOrGit pinned against the guard hook's own
  // originals, both directions -------------------------------------------------
  // guard(#123): classify.ts's reimplementation (scripts/ may not depend on
  // plugins/port/hooks/lib's internals) silently drifting from the guard
  // hook's own predicate, so a command the hook would flag stops being
  // detected here, or vice versa.
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
      if (!loopMatch) fail('forensics-shell-rules', `usesShellLoop disagrees between classify.ts and command-rules.mjs for ${JSON.stringify(cmd)}`);
      else ok();
      if (!targetMatch) fail('forensics-shell-rules', `targetsGhOrGit disagrees between classify.ts and command-rules.mjs for ${JSON.stringify(cmd)}`);
      else ok();
    }
  }

  // --- (3) STAGE_AGENTS pinned against plugins/port/agents/'s real basenames
  // and apps/desktop's own PORT_STAGE_AGENTS, both directions -----------------
  // guard(#123): the item-correlation stage list drifting from either the
  // shipped agent set or the desktop app's own copy, silently mis-attributing
  // (or dropping) a finding's stage.
  {
    const agentBasenames = new Set(readdirSync(join(root, 'plugins/port/agents')).filter((f) => f.endsWith('.md')).map((f) => basename(f, '.md')));
    const engineSet = new Set<string>(classify.STAGE_AGENTS);
    for (const name of agentBasenames) {
      if (!engineSet.has(name)) fail('forensics-stages', `plugins/port/agents/${name}.md exists, but classify.ts's STAGE_AGENTS does not name '${name}'`);
      else ok();
    }
    for (const name of engineSet) {
      if (!agentBasenames.has(name)) fail('forensics-stages', `classify.ts's STAGE_AGENTS names '${name}', which plugins/port/agents/ does not carry`);
      else ok();
    }

    const desktopRel = 'apps/desktop/src/main/sessions/classify.ts';
    const desktopText = readFileSync(join(root, desktopRel), 'utf8');
    const m = /PORT_STAGE_AGENTS[^=]*=\s*\[([^\]]*)\]/.exec(desktopText);
    if (!m) {
      fail('forensics-stages', `${desktopRel} has no 'PORT_STAGE_AGENTS = [...]' to read`);
    } else {
      const desktopStages = new Set([...m[1].matchAll(/'([^']+)'/g)].map((mm) => mm[1]));
      for (const name of engineSet) {
        if (!desktopStages.has(name)) fail('forensics-stages', `classify.ts's STAGE_AGENTS names '${name}', which ${desktopRel}'s PORT_STAGE_AGENTS does not`);
        else ok();
      }
      for (const name of desktopStages) {
        if (!engineSet.has(name)) fail('forensics-stages', `${desktopRel}'s PORT_STAGE_AGENTS names '${name}', which classify.ts's STAGE_AGENTS does not`);
        else ok();
      }
    }
  }

  // --- (4) Read-only, no busy child process, no whole-transcript mode --------
  // guard(#123): the engine silently gaining a write path, a filtered
  // GraphQL read, a second spawn, or a flag that inlines a whole transcript
  // — the ticket's own "never inline a transcript" and "one gh api graphql
  // call" rails, mirrored from scripts/checks/tick.ts's own "tick-readonly"
  // and "tick-io" checks.
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
        // 'git' is fine anywhere (the CLI's own repoRoot() helper); 'gh' is
        // fine only inside the reused scripts/port-tick/gh.ts, which this
        // walk never includes.
        if (bin === 'git') continue;
        fail('forensics-io', `${rel} spawns '${bin}' directly — every GitHub read must go through the reused scripts/port-tick/gh.ts, and nothing else may shell out`);
      }
      ok();

      if (/--jq\b/.test(text)) fail('forensics-io', `${rel} uses --jq — the GraphQL call must always be parsed in full, never filtered`);
      else ok();
      if (/shell:\s*true/.test(text)) fail('forensics-io', `${rel} passes shell: true to a child process`);
      else ok();
      if (/\bgh (issue|pr|label) (edit|comment|create|merge|close)\b/.test(text) || /--add-label\b|--remove-label\b/.test(text)) {
        fail('forensics-io', `${rel} spells out a mutating 'gh' subcommand or label-write flag literal — this engine is read-only, with no write path at all`);
      } else {
        ok();
      }
      // A whole-transcript dump: any flag literal that looks like it would
      // print raw records instead of findings.
      if (/--dump\b|--raw\b|--full\b/.test(text)) {
        fail('forensics-io', `${rel} names a flag that reads like a whole-transcript dump — the CLI has no such mode`);
      } else {
        ok();
      }
    }
  }

  // --- (5) excerpt is the one chokepoint for transcript-derived text ---------
  // guard(#123): a finding printing raw, unsanitized, uncapped transcript
  // text — the ticket's own "one excerpt chokepoint" rule. Nothing outside
  // scripts/lib/transcript.ts may reimplement the control/bidi sanitizer.
  {
    const files = walk(join(root, FORENSICS_DIR)).filter((f) => f.endsWith('.ts'));
    for (const f of files) {
      const rel = relOf(f);
      const text = stripComments(readFileSync(f, 'utf8'));
      if (/0x00|0x1f|0x7f|202a|2066/.test(text)) {
        fail('forensics-excerpt', `${rel} appears to reimplement sanitize's control/bidi ranges — every sanitizer lives in ${TRANSCRIPT_REL} alone`);
      } else {
        ok();
      }
    }
  }

  // --- (6) No running/alive/isLive identifier ----------------------------------
  // guard(#123): recency read as liveness — the same rail
  // docs/ENGINEERING.md §4 states for apps/desktop's own session adapter.
  // Scoped to identifiers, never string literals: 'running' is a real
  // task_status.status value the parser must still carry.
  {
    const files = [join(root, CLI_REL), join(root, TRANSCRIPT_REL), ...walk(join(root, FORENSICS_DIR)).filter((f) => f.endsWith('.ts'))];
    const identifierRe = /\b(?:const|let|var|function)\s+(running|isLive|alive)\b|\.(running|isLive|alive)\s*=/;
    for (const f of files) {
      const text = stripComments(readFileSync(f, 'utf8'));
      if (identifierRe.test(text)) {
        fail('forensics-liveness', `${relOf(f)} declares a 'running'/'isLive'/'alive'-named identifier — a transcript's recency is never liveness`);
      } else {
        ok();
      }
    }
  }

  // --- (7) commands.forensics never enters commands.checks --------------------
  // guard(#123): every dispatched agent's worktree running the forensics
  // engine before pushing — it reads a machine-local path outside the
  // repository and shells out to gh, meaningless in CI. Pinned here as a
  // second, engine-specific rail alongside scripts/checks/evals.ts's own
  // general banned-commands check.
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

  // --- (7b) schema/template both carry commands.forensics, defaulting null ---
  // guard(#123): the new config key landing in one of the two and not the
  // other, the same "config template matches its own schema's shape" rail
  // scripts/checks/config.ts already holds for commands.checks.
  {
    const schema = readJson('schema/port.config.schema.json');
    const forensicsSchema = schema.properties?.commands?.properties?.forensics;
    if (!forensicsSchema || JSON.stringify(forensicsSchema.type) !== JSON.stringify(['string', 'null']) || forensicsSchema.default !== null) {
      fail('forensics-scope', "schema/port.config.schema.json's commands.forensics must be type ['string','null'] with default null");
    } else {
      ok();
    }
    const template = readJson('plugins/port/templates/port.config.json');
    if (template.commands?.forensics !== null) {
      fail('forensics-scope', `plugins/port/templates/port.config.json's commands.forensics must be null, got ${JSON.stringify(template.commands?.forensics)}`);
    } else {
      ok();
    }
  }

  // --- (7c) No hardcoded ~/.claude — the Claude home is always resolved -------
  // guard(#123): a literal '~/.claude' or '.claude' home path bypassing
  // CLAUDE_CONFIG_DIR, breaking for any operator whose home is elsewhere.
  {
    const text = stripComments(readFileSync(join(root, FORENSICS_DIR, 'scan.ts'), 'utf8'));
    if (/['"]~\/\.claude['"]/.test(text)) {
      fail('forensics-scope', 'scan.ts hardcodes a literal ~/.claude path — the Claude home must be resolved via CLAUDE_CONFIG_DIR then os.homedir()');
    } else {
      ok();
    }
  }

  // --- (8) The fixture tree exercises scan.ts's resolve and degrade paths ---
  // guard(#123): "absent or unreadable session directories degrade to one
  // clear line, never a stack trace" (the plan's own acceptance criterion),
  // regressing silently the next time scan.ts's shape changes.
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
        if (session.malformed !== 1) fail('forensics-fixtures', `expected 1 malformed line in the fixture session, got ${session.malformed}`);
        else ok();
        if (session.agents.length !== 1) {
          fail('forensics-fixtures', `expected 1 readable agent transcript (the malformed-meta sidecar must degrade, not crash), got ${session.agents.length}`);
        } else {
          ok();
          const term = classify.classifyTermination(session.agents[0].records);
          if (term.class !== 'terminal') fail('forensics-fixtures', `expected the fixture agent to classify 'terminal', got '${term.class}'`);
          else ok();
        }
        if (session.problems.length === 0) {
          fail('forensics-fixtures', 'expected at least one degraded problem (the malformed-meta sidecar) in the fixture session, got none');
        } else {
          ok();
        }
      }
    }

    // Absent tree: a directory that does not exist degrades to a named
    // result, never a thrown error.
    const missing = scan.buildProjectIndex(join(root, FORENSICS_DIR, 'fixtures-does-not-exist'));
    if (missing.ok || missing.kind !== 'claude-home-missing') {
      fail('forensics-fixtures', `buildProjectIndex over an absent tree must report 'claude-home-missing', got ${JSON.stringify(missing)}`);
    } else {
      ok();
    }
  }

  // --- (9) report.ts's own orchestration runs end to end, without a `gh`
  // call, over the fixture tree and over an absent one -------------------------
  // guard(#123): a wiring bug in report.ts (an undefined field access, a
  // thrown exception) that no per-function case table can catch, since each
  // of those tests one function in isolation. No `args.repoRoot` is passed,
  // so the orphan assertion degrades to "not computable" rather than
  // shelling out to `gh` from a layer 1 check.
  {
    const reportMod = await importEngine(`${FORENSICS_DIR}/report.ts`);
    const fixtureHome = join(root, FORENSICS_DIR, 'fixtures');

    try {
      const result = reportMod.runReport({ claudeHome: fixtureHome });
      if (![0, 1].includes(result.exitCode)) {
        fail('forensics-report', `runReport over the fixture tree returned exitCode ${result.exitCode}, expected 0 or 1`);
      } else if (result.notes.length === 0) {
        fail('forensics-report', 'runReport over the fixture tree produced no notes at all');
      } else {
        ok();
      }
      const text = reportMod.renderText(result);
      const jsonBody = reportMod.renderJson(result);
      if (typeof text !== 'string' || text.length === 0) fail('forensics-report', 'renderText produced no text');
      else ok();
      if (!Array.isArray(jsonBody.notes) || !Array.isArray(jsonBody.findings)) fail('forensics-report', 'renderJson did not produce { notes, findings } arrays');
      else ok();
    } catch (e: any) {
      fail('forensics-report', `runReport threw over the fixture tree: ${e?.message ?? e}`);
    }

    try {
      const missingResult = reportMod.runReport({ claudeHome: join(root, FORENSICS_DIR, 'fixtures-does-not-exist') });
      if (missingResult.exitCode !== 2) fail('forensics-report', `runReport over an absent claude-home must exit 2, got ${missingResult.exitCode}`);
      else ok();
    } catch (e: any) {
      fail('forensics-report', `runReport threw over an absent claude-home instead of degrading: ${e?.message ?? e}`);
    }

    try {
      const invalidSession = reportMod.runReport({ claudeHome: fixtureHome, session: 'not-a-uuid' });
      if (invalidSession.exitCode !== 1) fail('forensics-report', `runReport with an invalid --session must exit 1, got ${invalidSession.exitCode}`);
      else ok();
      const invalidSince = reportMod.runReport({ claudeHome: fixtureHome, since: 'yesterday' });
      if (invalidSince.exitCode !== 1) fail('forensics-report', `runReport with an unparseable --since must exit 1, got ${invalidSince.exitCode}`);
      else ok();
    } catch (e: any) {
      fail('forensics-report', `runReport threw on a malformed argument instead of exiting 1: ${e?.message ?? e}`);
    }

    // A --since past every record in the fixture tree matches no session —
    // reported as a note, exit 0, distinguished from "read nothing".
    try {
      const noneMatched = reportMod.runReport({ claudeHome: fixtureHome, since: '2099-01-01T00:00:00.000Z' });
      if (noneMatched.exitCode !== 0 || noneMatched.findings.length !== 0 || !noneMatched.notes.some((n: string) => n.includes('0 sessions matched'))) {
        fail('forensics-report', `runReport with a --since matching no session must exit 0 with a '0 sessions matched' note, got ${JSON.stringify(noneMatched)}`);
      } else {
        ok();
      }
    } catch (e: any) {
      fail('forensics-report', `runReport threw on a --since matching no session: ${e?.message ?? e}`);
    }
  }
}
