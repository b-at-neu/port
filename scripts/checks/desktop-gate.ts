import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, readJson, walk, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// The plan gate's own eight mechanical rails — dependency-free, regex-based, reading
// directories by explicit path, never walk('apps/').
export default async function ({ expect, fail, ok }: Reporter) {
  const sharedGateDir = 'apps/desktop/src/shared/gate';
  const sharedMarkdownDir = 'apps/desktop/src/shared/markdown';
  const mainActionsDir = 'apps/desktop/src/main/actions';
  const rendererGateDir = 'apps/desktop/src/renderer/src/gate';
  const classifyFile = `${sharedGateDir}/classify.ts`;
  const typesFile = `${sharedGateDir}/types.ts`;
  const inlineFile = `${sharedMarkdownDir}/inline.ts`;
  const gateActionFile = `${mainActionsDir}/gate.ts`;
  const decideActionFile = `${mainActionsDir}/decide.ts`;
  const escalateActionFile = `${mainActionsDir}/escalate.ts`;
  const observeActionFile = `${mainActionsDir}/observe.ts`;
  const scopeFile = 'apps/desktop/src/main/writes/scope.ts';
  const writesApplyFile = 'apps/desktop/src/main/writes/apply.ts';
  const copyFile = `${rendererGateDir}/copy.ts`;
  const markdownFile = 'apps/desktop/src/renderer/src/components/markdown.tsx';
  const coordinationFile = 'docs/COORDINATION.md';

  const srcDir = join(root, 'apps/desktop/src');
  const allFiles = walk(srcDir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
  const rendererFiles = allFiles.filter((f) => relOf(f).startsWith('apps/desktop/src/renderer/'));
  const sharedGateFiles = allFiles.filter((f) => relOf(f).startsWith(`${sharedGateDir}/`));
  const sharedMarkdownFiles = allFiles.filter((f) => relOf(f).startsWith(`${sharedMarkdownDir}/`) && !relOf(f).endsWith('.test.ts'));

  if (sharedGateFiles.filter((f) => !relOf(f).endsWith('.test.ts')).length === 0) {
    fail('desktop-gate', `${sharedGateDir} has no source files — the guard cannot pass vacuously if the directory is deleted`);
    return;
  }
  if (sharedMarkdownFiles.length === 0) {
    fail('desktop-gate', `${sharedMarkdownDir} has no source files — the guard cannot pass vacuously if the directory is deleted`);
    return;
  }

  // pin: `shared/gate/classify.ts`'s LabelKeys (`planReview`/`planApproved`/`planChangesRequested`) ↔ `main/writes/scope.ts`'s `PLAN_GATE_KEYS`, both directions
  {
    const classifyText = readFileSync(join(root, classifyFile), 'utf8');
    const scopeText = readFileSync(join(root, scopeFile), 'utf8');
    const classifyKeys = new Set([...classifyText.matchAll(/'(plan[A-Za-z]+)'/g)].map((m) => m[1]));
    const scopeMatch = /PLAN_GATE_KEYS[^=]*=\s*\[([^\]]*)\]/.exec(scopeText);
    if (!scopeMatch) {
      fail('desktop-gate', `${scopeFile} has no 'PLAN_GATE_KEYS = [...]' array to compare against`);
    } else {
      const scopeKeys = new Set([...scopeMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
      const onlyInClassify = [...classifyKeys].filter((k) => !scopeKeys.has(k));
      const onlyInScope = [...scopeKeys].filter((k) => !classifyKeys.has(k));
      expect(!(onlyInClassify.length > 0 || onlyInScope.length > 0), 'desktop-gate', `${classifyFile}'s LabelKeys (${[...classifyKeys].join(', ')}) and ${scopeFile}'s PLAN_GATE_KEYS (${[...scopeKeys].join(', ')}) disagree`);
    }
  }

  // --- Both plans set expect.present to ['planReview'] — the "don't answer an item that already moved" guard must not be quietly dropped. ---
  {
    const text = readFileSync(join(root, classifyFile), 'utf8');
    expect(text.includes(`present: ['planReview']`), 'desktop-gate', `${classifyFile} does not set "present: ['planReview']" — the stale-item guard must not be quietly dropped`);
  }

  // pin: `shared/gate/types.ts`'s `GATE_CLAIM_OWNER` ↔ `docs/COORDINATION.md`'s stand-down report copy
  {
    const typesText = readFileSync(join(root, typesFile), 'utf8');
    const coordinationText = readFileSync(join(root, coordinationFile), 'utf8');
    const ownerMatch = /GATE_CLAIM_OWNER\s*=\s*'([^']+)'/.exec(typesText);
    if (!ownerMatch) {
      fail('desktop-gate', `${typesFile} has no 'GATE_CLAIM_OWNER = ...' assignment`);
    } else expect(coordinationText.includes(ownerMatch[1]), 'desktop-gate', `${coordinationFile} does not name '${ownerMatch[1]}' — the cockpit's stand-down report would name the wrong owner`);
  }

  // --- postComment( is called under apps/desktop/src/ only from gate.ts, decide.ts,
  // escalate.ts, and observe.ts — each in its own fixed comment/swap order, so a failed write never leaves a mismatched record. ---
  {
    let found = false;
    let sawGateFile = false;
    let sawDecideFile = false;
    let sawEscalateFile = false;
    let sawObserveFile = false;
    for (const f of allFiles) {
      const rel = relOf(f);
      if (rel.endsWith('.test.ts') || rel === writesApplyFile) continue; // the function's own definition site
      const text = readFileSync(f, 'utf8');
      if (!/\bpostComment\(/.test(text)) continue;
      if (rel === gateActionFile || rel === decideActionFile) {
        if (rel === gateActionFile) sawGateFile = true;
        else sawDecideFile = true;
        const commentIdx = text.indexOf('postComment(');
        const labelsIdx = text.indexOf('applyLabels(');
        if (labelsIdx === -1 || commentIdx > labelsIdx) {
          found = true;
          fail('desktop-gate', `${rel}'s postComment( call must precede its applyLabels( call in source order — the comment-then-swap ordering`);
        }
      } else if (rel === escalateActionFile || rel === observeActionFile) {
        if (rel === escalateActionFile) sawEscalateFile = true;
        else sawObserveFile = true;
        const labelsIdx = text.indexOf('applyLabels(');
        const commentIdx = text.indexOf('postComment(');
        if (labelsIdx === -1 || labelsIdx > commentIdx) {
          found = true;
          fail('desktop-gate', `${rel}'s applyLabels( call must precede its postComment( call in source order — the swap-then-comment ordering`);
        }
      } else {
        found = true;
        fail('desktop-gate', `${rel} calls postComment( — only ${gateActionFile}, ${decideActionFile}, ${escalateActionFile}, and ${observeActionFile} may`);
      }
    }
    if (!sawGateFile) fail('desktop-gate', `${gateActionFile} does not call postComment( — the guard cannot pass vacuously`);
    else if (!sawDecideFile) fail('desktop-gate', `${decideActionFile} does not call postComment( — the guard cannot pass vacuously`);
    else if (!sawEscalateFile) fail('desktop-gate', `${escalateActionFile} does not call postComment( — the guard cannot pass vacuously`);
    else if (!sawObserveFile) fail('desktop-gate', `${observeActionFile} does not call postComment( — the guard cannot pass vacuously`);
    else if (!found) ok();
  }

  // --- shared/markdown/ imports no node: builtin and nothing from main/; renderer/src/
  // components/markdown.tsx is the only renderer file importing it, the one DOM-building consumer. ---
  {
    let impure = false;
    for (const f of sharedMarkdownFiles) {
      const text = readFileSync(f, 'utf8');
      if (/from\s+'node:/.test(text) || /from\s+'.*\/main\//.test(text) || /from\s+'\.\.\/\.\.\/main\//.test(text)) {
        impure = true;
        fail('desktop-gate', `${relOf(f)} imports a node: builtin or a main/ path — shared/markdown/ must compile under typecheck:web`);
      }
    }
    let found = false;
    let sawMarkdownFile = false;
    for (const f of rendererFiles) {
      const rel = relOf(f);
      if (rel.endsWith('.test.ts')) continue;
      const text = readFileSync(f, 'utf8');
      if (!text.includes('shared/markdown')) continue;
      if (rel === markdownFile) sawMarkdownFile = true;
      else {
        found = true;
        fail('desktop-gate', `${rel} imports shared/markdown/ — only ${markdownFile} may, under renderer/`);
      }
    }
    if (!sawMarkdownFile) fail('desktop-gate', `${markdownFile} does not import shared/markdown/ — the guard cannot pass vacuously`);
    else if (!found && !impure) ok();
  }

  // --- inline.ts's scheme allowlist names exactly http:// and https:// — any other scheme
  // becoming clickable in an Electron renderer is a code-execution sink. ---
  {
    const text = readFileSync(join(root, inlineFile), 'utf8');
    const match = /LINK_SCHEMES\s*=\s*\[([^\]]*)\]/.exec(text);
    if (!match) {
      fail('desktop-gate', `${inlineFile} has no 'LINK_SCHEMES = [...]' array`);
    } else {
      const schemes = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
      const expected = ['http://', 'https://'];
      expect(!(schemes.length !== expected.length || !expected.every((s) => schemes.includes(s))), 'desktop-gate', `${inlineFile}'s LINK_SCHEMES is ${JSON.stringify(schemes)} — must name exactly ${JSON.stringify(expected)}`);
    }
  }

  // --- copy.ts's session-required consequence and claim-step lines — the operator must
  // learn that an approved session-required plan will not be dispatched. ---
  {
    const text = readFileSync(join(root, copyFile), 'utf8');
    const missing: string[] = [];
    if (!text.includes('/port:implement')) missing.push("'/port:implement'");
    if (!text.includes('no agent will ever pick it up')) missing.push("'no agent will ever pick it up'");
    if (!text.includes("isn't claimed here")) missing.push(`the absent-claim line ("isn't claimed here")`);
    if (!text.includes('still answering it in your terminal')) missing.push('the absent-claim note');
    if (!text.includes("can't be read")) missing.push(`the unreadable-claim line ("can't be read")`);
    if (!text.includes('stand down from the plan gate')) missing.push('the unreadable-claim note');
    expect(!(missing.length > 0), 'desktop-gate', `${copyFile} is missing: ${missing.join(', ')}`);
  }

  // --- No file under shared/gate/, main/actions/, or renderer/src/gate/ names a literal
  // label name instead of resolving through the vocabulary as a LabelKey. ---
  {
    const mainActionsFiles = allFiles.filter((f) => relOf(f).startsWith(`${mainActionsDir}/`));
    const rendererGateFiles = allFiles.filter((f) => relOf(f).startsWith(`${rendererGateDir}/`));
    const mismatched = readJson('plugins/port/data/labels.json')
      .labels.filter((l: any) => l.key !== l.name)
      .map((l: any) => l.name);
    let found = false;
    for (const f of [...sharedGateFiles, ...mainActionsFiles, ...rendererGateFiles]) {
      const rel = relOf(f);
      if (rel.endsWith('.test.ts')) continue;
      const text = readFileSync(f, 'utf8');
      for (const name of mismatched) {
        if (text.includes(`'${name}'`) || text.includes(`"${name}"`)) {
          found = true;
          fail('desktop-gate', `${rel} contains the literal label name '${name}' — resolve it through the vocabulary as a LabelKey instead`);
        }
      }
    }
    if (!found) ok();
  }

  // --- GATE_ACTIONS carries 'auto-approve-plan', and gate.ts never posts a comment for it
  // — this write has no operator feedback to attach. ---
  {
    const typesText = readFileSync(join(root, typesFile), 'utf8');
    const gateText = readFileSync(join(root, gateActionFile), 'utf8');
    if (!typesText.includes("'auto-approve-plan'")) {
      fail('desktop-gate', `${typesFile}'s GATE_ACTIONS is missing 'auto-approve-plan' — the auto-plan swap needs its own audit-distinguishable action`);
    } else if (!gateText.includes('autoApprovePlan')) {
      fail('desktop-gate', `${gateActionFile} has no autoApprovePlan export — the auto-plan swap's own write composition is missing`);
    } else {
      const fnStart = gateText.indexOf('export async function autoApprovePlan');
      const fnBody = fnStart === -1 ? '' : gateText.slice(fnStart, gateText.indexOf('\n}', fnStart));
      expect(!fnBody.includes('postComment('), 'desktop-gate', `${gateActionFile}'s autoApprovePlan calls postComment( — this write has no operator feedback to attach, it must post none`);
    }
  }
}
