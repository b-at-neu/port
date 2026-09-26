import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// #90: apps/desktop/src/main/writes/ is the app's only GitHub writer, the
// mirror of main/github/'s own reader rail. Eight assertions pin its plan's
// decisions mechanically, dependency-free and regex-based, in the shape of
// desktop-github.ts's and desktop-platform.ts's own guards — reading these
// directories by explicit path (never walk('apps/'), which descends into
// node_modules).
export default async function ({ fail, ok }: Reporter) {
  const platformDir = 'apps/desktop/src/main/platform';
  const githubDir = 'apps/desktop/src/main/github';
  const writesDir = 'apps/desktop/src/main/writes';
  const commandFile = `${writesDir}/command.ts`;
  const claimFile = `${writesDir}/claim.ts`;
  const scopeFile = `${writesDir}/scope.ts`;
  const typesFile = 'apps/desktop/src/shared/writes/types.ts';
  const coordinationFile = 'docs/COORDINATION.md';

  const srcDir = join(root, 'apps/desktop/src');
  const allFiles = walk(srcDir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
  const writesFiles = allFiles.filter((f) => relOf(f).startsWith(`${writesDir}/`) && !relOf(f).endsWith('.test.ts'));

  if (writesFiles.length === 0) {
    fail('desktop-writes', `${writesDir} has no source files — the guard cannot pass vacuously if the directory is deleted`);
    return;
  }

  // --- '../platform/gh' is imported under apps/desktop/src/ only from -------
  // guard(#90): a second GitHub writer bypassing the chokepoint, or the
  // chokepoint itself losing its only caller.
  // main/github/ and main/writes/, and both do import it. `gh`/`ghJson` are
  // always called through an injected seam (`params.gh ?? defaultGh`), never
  // as a bare literal call at every call site, so the import path — not a
  // call-site regex — is the mechanically checkable fact here.
  {
    let sawGithub = false;
    let sawWrites = false;
    for (const f of allFiles) {
      const rel = relOf(f);
      if (rel.startsWith(`${platformDir}/`) || rel.endsWith('.test.ts')) continue;
      const text = readFileSync(f, 'utf8');
      if (!text.includes("from '../platform/gh'")) continue;
      if (rel.startsWith(`${githubDir}/`)) {
        sawGithub = true;
      } else if (rel.startsWith(`${writesDir}/`)) {
        sawWrites = true;
      } else {
        fail('desktop-writes', `${rel} imports '../platform/gh' — only main/github/ and main/writes/ may call gh/ghJson`);
      }
    }
    if (!sawGithub) fail('desktop-writes', `no file under ${githubDir} imports '../platform/gh' — the guard cannot pass vacuously`);
    if (!sawWrites) fail('desktop-writes', `no file under ${writesDir} imports '../platform/gh' — the guard cannot pass vacuously`);
    if (sawGithub && sawWrites) ok();
  }

  // --- No file under main/writes/ contains 'graphql' or builds a query ------
  // guard(#90): the observed state coming from anywhere but
  // fetchItemsByNumber, re-implementing a second query builder.
  // The observed state comes only from fetchItemsByNumber (../github) —
  // never a second GraphQL caller.
  {
    let found = false;
    for (const f of writesFiles) {
      const text = readFileSync(f, 'utf8');
      if (/graphql/i.test(text)) {
        found = true;
        fail('desktop-writes', `${relOf(f)} contains 'graphql' — the observed state comes only from fetchItemsByNumber, imported from ../github`);
      }
    }
    if (!found) ok();
  }

  // --- No file under main/writes/ passes merge/close/--delete-branch/ready --
  // guard(#90): merging or closing a pull request stopping being a
  // human-only action.
  // as a gh subcommand argument — merging and closing stay human actions.
  {
    let found = false;
    const forbidden = /['"](merge|close|--delete-branch|ready)['"]/;
    for (const f of writesFiles) {
      const text = readFileSync(f, 'utf8');
      const m = forbidden.exec(text);
      if (m) {
        found = true;
        fail('desktop-writes', `${relOf(f)} contains the literal ${m[0]} — main/writes/ never passes merge, close, --delete-branch, or ready to gh`);
      }
    }
    if (!found) ok();
  }

  // --- --add-label/--remove-label appear only in main/writes/command.ts -----
  // guard(#90): a label name reaching gh without resolving through the
  // vocabulary.
  {
    let found = false;
    for (const f of allFiles) {
      const rel = relOf(f);
      if (rel.endsWith('.test.ts')) continue;
      const text = readFileSync(f, 'utf8');
      const hasAdd = text.includes('--add-label');
      const hasRemove = text.includes('--remove-label');
      if (!hasAdd && !hasRemove) continue;
      if (rel !== commandFile) {
        found = true;
        fail('desktop-writes', `${rel} contains '--add-label'/'--remove-label' — only ${commandFile} may name them`);
      }
    }
    const commandText = readFileSync(join(root, commandFile), 'utf8');
    if (!commandText.includes('--add-label') || !commandText.includes('--remove-label')) {
      fail('desktop-writes', `${commandFile} does not contain '--add-label'/'--remove-label' — the guard cannot pass vacuously`);
    } else if (!/\blabelName\b/.test(commandText)) {
      fail('desktop-writes', `${commandFile} does not import 'labelName' — every key must resolve through the vocabulary`);
    } else if (!found) {
      ok();
    }
  }

  // --- PLAN_GATE_KEYS matches docs/COORDINATION.md's claim contract, both ---
  // guard(#90): the claim gating a different set of labels than the doc
  // that defines it.
  // directions.
  // pin: `main/writes/scope.ts`'s `PLAN_GATE_KEYS` ↔ `docs/COORDINATION.md`'s claim-contract keys, both directions
  {
    const scopeText = readFileSync(join(root, scopeFile), 'utf8');
    const scopeMatch = /PLAN_GATE_KEYS[^=]*=\s*\[([^\]]*)\]/.exec(scopeText);
    const coordinationText = readFileSync(join(root, coordinationFile), 'utf8');
    const coordinationMatch = /adding or removing the resolved names for ([^.]*)\./.exec(coordinationText);

    if (!scopeMatch) {
      fail('desktop-writes', `${scopeFile} has no 'PLAN_GATE_KEYS = [...]' array`);
    } else if (!coordinationMatch) {
      fail('desktop-writes', `${coordinationFile} has no "adding or removing the resolved names for ..." sentence to compare against`);
    } else {
      const scopeKeys = [...scopeMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
      const coordinationKeys = [...coordinationMatch[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]).sort();
      const scopeSet = new Set(scopeKeys);
      const coordinationSet = new Set(coordinationKeys);
      const onlyInScope = scopeKeys.filter((k) => !coordinationSet.has(k));
      const onlyInDoc = coordinationKeys.filter((k) => !scopeSet.has(k));
      if (onlyInScope.length > 0 || onlyInDoc.length > 0) {
        fail(
          'desktop-writes',
          `${scopeFile}'s PLAN_GATE_KEYS (${JSON.stringify(scopeKeys)}) and ${coordinationFile}'s claim contract (${JSON.stringify(coordinationKeys)}) disagree`,
        );
      } else {
        ok();
      }
    }
  }

  // --- The Conflict union matches COORDINATION.md's fenced block, both ------
  // guard(#90): the app's conflict shape drifting from the copy decided in
  // COORDINATION.md.
  // directions — by literal kind and field-name set, not byte-identity (the
  // doc's fence omits the `readonly` modifiers this app's style requires).
  // pin: `shared/writes/types.ts`'s `Conflict` union ↔ `docs/COORDINATION.md`'s fenced `type Conflict` block — kind literals and field-name sets, both directions, not byte-identity
  {
    const typesText = readFileSync(join(root, typesFile), 'utf8');
    const typesMatch = /export type Conflict =\n([\s\S]*?)\n\n/.exec(typesText);
    const coordinationText = readFileSync(join(root, coordinationFile), 'utf8');
    const docMatch = /```ts\n(type Conflict[\s\S]*?)\n```/.exec(coordinationText);

    if (!typesMatch) {
      fail('desktop-writes', `${typesFile} has no 'export type Conflict = ...' block`);
    } else if (!docMatch) {
      fail('desktop-writes', `${coordinationFile} has no fenced 'type Conflict = ...' block to compare against`);
    } else {
      const appVariants = extractVariants(typesMatch[1]);
      const docVariants = extractVariants(docMatch[1]);
      const mismatches = diffVariants(appVariants, docVariants);
      if (mismatches.length > 0) {
        for (const m of mismatches) fail('desktop-writes', m);
      } else {
        ok();
      }
    }
  }

  // --- .agents/gate-claim.json appears in both claim.ts and COORDINATION.md -
  // guard(#90): the claim file's path silently diverging between the code
  // and its own contract doc.
  {
    const claimText = readFileSync(join(root, claimFile), 'utf8');
    const coordinationText = readFileSync(join(root, coordinationFile), 'utf8');
    if (!claimText.includes('.agents/gate-claim.json') && !claimText.includes("'.agents', 'gate-claim.json'")) {
      fail('desktop-writes', `${claimFile} does not reference the gate-claim.json path`);
    } else if (!coordinationText.includes('.agents/gate-claim.json')) {
      fail('desktop-writes', `${coordinationFile} does not reference '.agents/gate-claim.json'`);
    } else {
      ok();
    }
  }

  // --- appendTextFile( is called under apps/desktop/src/ only from ----------
  // guard(#90): a second path writing an audit entry that skipped the
  // chokepoint.
  // main/writes/audit.ts — one appender, so no second path can write an
  // entry that skipped the chokepoint.
  {
    const auditFile = `${writesDir}/audit.ts`;
    let found = false;
    let sawAudit = false;
    for (const f of allFiles) {
      const rel = relOf(f);
      if (rel.startsWith(`${platformDir}/`)) continue;
      const text = readFileSync(f, 'utf8');
      if (!/\bappendTextFile\s*\(/.test(text)) continue;
      if (rel === auditFile) {
        sawAudit = true;
      } else {
        found = true;
        fail('desktop-writes', `${rel} calls 'appendTextFile(' — only ${auditFile} may append to the audit log`);
      }
    }
    if (!sawAudit) fail('desktop-writes', `${auditFile} does not call 'appendTextFile(' — the guard cannot pass vacuously`);
    else if (!found) ok();
  }
}

/** Parses a `type X = | { kind: 'a'; f1: T; f2: T } | { kind: 'b'; ... }`
 *  block into `Map<kind, Set<fieldName>>` — flat single-line object types
 *  with no nested braces, which is the shape both the app's own union and
 *  COORDINATION.md's fenced copy use. */
function extractVariants(text: string): Map<string, Set<string>> {
  const variants = new Map<string, Set<string>>();
  const objectRegex = /\{([^{}]*)\}/g;
  let m;
  while ((m = objectRegex.exec(text))) {
    const body = m[1];
    const kindMatch = /kind\s*:\s*'([^']+)'/.exec(body);
    if (!kindMatch) continue;
    const fields = new Set<string>();
    const fieldRegex = /(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:/g;
    let fm;
    while ((fm = fieldRegex.exec(body))) {
      if (fm[1] !== 'kind') fields.add(fm[1]);
    }
    variants.set(kindMatch[1], fields);
  }
  return variants;
}

function diffVariants(appVariants: Map<string, Set<string>>, docVariants: Map<string, Set<string>>): string[] {
  const mismatches: string[] = [];
  const allKinds = new Set([...appVariants.keys(), ...docVariants.keys()]);
  for (const kind of allKinds) {
    const appFields = appVariants.get(kind);
    const docFields = docVariants.get(kind);
    if (!appFields) {
      mismatches.push(`Conflict variant '${kind}' is in COORDINATION.md but not in the app's own type`);
      continue;
    }
    if (!docFields) {
      mismatches.push(`Conflict variant '${kind}' is in the app's own type but not in COORDINATION.md`);
      continue;
    }
    const onlyInApp = [...appFields].filter((f) => !docFields.has(f));
    const onlyInDoc = [...docFields].filter((f) => !appFields.has(f));
    if (onlyInApp.length > 0 || onlyInDoc.length > 0) {
      mismatches.push(`Conflict variant '${kind}' field mismatch — app: ${JSON.stringify([...appFields])}, doc: ${JSON.stringify([...docFields])}`);
    }
  }
  return mismatches;
}
