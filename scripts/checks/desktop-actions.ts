import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, readJson, walk, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// The single-label operator actions and operator decisions — mechanical, dependency-free,
// regex-based rails, reading directories by explicit path, never walk('apps/').
export default async function ({ expect, fail, ok }: Reporter) {
  const sharedActionsDir = 'apps/desktop/src/shared/actions';
  const mainActionsDir = 'apps/desktop/src/main/actions';
  const bodiesFile = `${sharedActionsDir}/bodies.ts`;
  const projectFile = 'apps/desktop/src/shared/board/project.ts';
  const scriptsPortTickGatesFile = 'scripts/port-tick/gates.ts';
  const observationFile = 'apps/desktop/src/main/dispatch/observation.ts';
  const formatsFile = 'plugins/port/docs/FORMATS.md';

  const srcDir = join(root, 'apps/desktop/src');
  const allFiles = walk(srcDir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
  const sharedActionsFiles = allFiles.filter((f) => relOf(f).startsWith(`${sharedActionsDir}/`));
  const mainActionsFiles = allFiles.filter((f) => relOf(f).startsWith(`${mainActionsDir}/`));

  // --- shared/actions/ has source files, so deleting the directory cannot pass vacuously. ---
  if (sharedActionsFiles.filter((f) => !relOf(f).endsWith('.test.ts')).length === 0) {
    fail('desktop-actions', `${sharedActionsDir} has no source files — the guard cannot pass vacuously if the directory is deleted`);
    return;
  }

  // shared/actions/plan.ts's RETRY_TRIGGER derives from scripts/port-tick/liveness.ts's
  // export directly, so the assignment itself typechecks against LabelKey.

  // --- No file under shared/actions/ imports a node: builtin or a main/ path — the pure
  // action-derivation layer must keep its `typecheck:web` compatibility. ---
  {
    let found = false;
    for (const f of sharedActionsFiles) {
      const text = readFileSync(f, 'utf8');
      if (/from\s+'node:/.test(text) || /from\s+'.*\/main\//.test(text) || /from\s+'\.\.\/\.\.\/main\//.test(text)) {
        found = true;
        fail('desktop-actions', `${relOf(f)} imports a node: builtin or a main/ path — shared/actions/ must compile under typecheck:web`);
      }
    }
    if (!found) ok();
  }

  // --- No non-test file under shared/actions/ or main/actions/ retypes a hand-typed label
  // name instead of resolving through the vocabulary. Checked only where key !== name. ---
  {
    const mismatched = readJson('plugins/port/data/labels.json')
      .labels.filter((l: any) => l.key !== l.name)
      .map((l: any) => l.name);
    let found = false;
    for (const f of [...sharedActionsFiles, ...mainActionsFiles]) {
      const rel = relOf(f);
      if (rel.endsWith('.test.ts')) continue;
      const text = readFileSync(f, 'utf8');
      for (const name of mismatched) {
        if (text.includes(`'${name}'`) || text.includes(`"${name}"`)) {
          found = true;
          fail('desktop-actions', `${rel} contains the literal label name '${name}' — resolve it through the vocabulary as a LabelKey instead`);
        }
      }
    }
    if (!found) ok();
  }

  // --- applyLabels( is called under apps/desktop/src/ only from main/actions/, the one write chokepoint. No exception left. ---
  {
    const definitionFile = 'apps/desktop/src/main/writes/apply.ts';
    let found = false;
    let sawMainActions = false;
    for (const f of allFiles) {
      const rel = relOf(f);
      // main/writes/apply.ts is the function's own definition site, not a call.
      if (rel.endsWith('.test.ts') || rel === definitionFile) continue;
      const text = readFileSync(f, 'utf8');
      if (!/\bapplyLabels\(/.test(text)) continue;
      if (rel.startsWith(`${mainActionsDir}/`)) {
        sawMainActions = true;
      } else {
        found = true;
        fail('desktop-actions', `${rel} calls applyLabels( — only ${mainActionsDir}/ may`);
      }
    }
    if (!sawMainActions) fail('desktop-actions', `no file under ${mainActionsDir} calls applyLabels( — the guard cannot pass vacuously`);
    else if (!found) ok();
  }

  // --- shared/board/project.ts's ungated selection names approvalGate, so the section is
  // absent entirely when the module is off, never rendering regardless. ---
  {
    const text = readFileSync(join(root, projectFile), 'utf8');
    const lines = text.split('\n');
    const ungatedLine = lines.findIndex((line) => /\bungated\s*=/.test(line));
    if (ungatedLine === -1) {
      fail('desktop-actions', `${projectFile} has no 'ungated = ...' selection to check`);
    } else {
      const window = lines.slice(Math.max(0, ungatedLine - 15), ungatedLine + 1).join('\n');
      expect(window.includes('approvalGate'), 'desktop-actions', `${projectFile}'s ungated selection does not name 'approvalGate' nearby — the module gate could be dropped silently`);
    }
  }

  // --- bodies.ts has no non-`import type` import, for layer 1's own import --
  {
    const text = readFileSync(join(root, bodiesFile), 'utf8');
    const badImport = text.split('\n').some((line) => /^import\b/.test(line.trim()) && !/^import\s+type\b/.test(line.trim()));
    expect(!badImport, 'desktop-actions', `${bodiesFile} has a non-'import type' import — it must stay zero-runtime-dependency`);
  }

  // --- The comment bodies pass their own validators and pin their headings --
  {
    const bodies = (await import(pathToFileURL(join(root, bodiesFile)).href)) as {
      CHANGES_REQUESTED_HEADING: string;
      GATE_CLEARED_HEADING: string;
      PIPELINE_ESCALATION_HEADING: string;
      changesRequestedBody: (headRefOid: string, note: string) => string;
    };
    const artifacts = (await import(pathToFileURL(join(root, 'plugins/port/bin/artifacts.mjs')).href)) as {
      CHANGES_REQUESTED_HEADING: string;
      CHECKS: Record<string, { run: (text: string) => { ok: boolean } }>;
    };

    const rendered = bodies.changesRequestedBody('a'.repeat(40), 'rename X');
    expect(artifacts.CHECKS['changes-requested'].run(rendered).ok, 'desktop-actions', `${bodiesFile}'s changesRequestedBody output fails artifacts.mjs's own 'changes-requested' validator`);

    expect(!(bodies.CHANGES_REQUESTED_HEADING !== artifacts.CHANGES_REQUESTED_HEADING), 'desktop-actions', `${bodiesFile}'s CHANGES_REQUESTED_HEADING ('${bodies.CHANGES_REQUESTED_HEADING}') disagrees with artifacts.mjs's ('${artifacts.CHANGES_REQUESTED_HEADING}')`);

    const formatsText = readFileSync(join(root, formatsFile), 'utf8');
    expect(formatsText.includes('Requested by the operator on `<head-sha>`, after approval:'), 'desktop-actions', `${formatsFile}'s "Changes requested" fence no longer names the exact line ${bodiesFile}'s changesRequestedBody renders`);

    const portTickGatesText = readFileSync(join(root, scriptsPortTickGatesFile), 'utf8');
    const portTickGatesMatch = /GATE_CLEARED_PREFIX\s*=\s*'([^']+)'/.exec(portTickGatesText);
    if (!portTickGatesMatch) {
      fail('desktop-actions', `${scriptsPortTickGatesFile} has no 'GATE_CLEARED_PREFIX = ...' literal to compare`);
    } else expect(!(bodies.GATE_CLEARED_HEADING !== portTickGatesMatch[1]), 'desktop-actions', `${bodiesFile}'s GATE_CLEARED_HEADING ('${bodies.GATE_CLEARED_HEADING}') disagrees with ${scriptsPortTickGatesFile}'s ('${portTickGatesMatch[1]}')`);

    const observationText = readFileSync(join(root, observationFile), 'utf8');
    const observationMatch = /PIPELINE_ESCALATION\s*=\s*'([^']+)'/.exec(observationText);
    if (!observationMatch) {
      fail('desktop-actions', `${observationFile} has no 'PIPELINE_ESCALATION = ...' literal to compare`);
    } else expect(!(bodies.PIPELINE_ESCALATION_HEADING !== observationMatch[1]), 'desktop-actions', `${bodiesFile}'s PIPELINE_ESCALATION_HEADING ('${bodies.PIPELINE_ESCALATION_HEADING}') disagrees with ${observationFile}'s ('${observationMatch[1]}')`);
  }
}
