import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// apps/desktop/src/main/writes/ is the app's only GitHub writer, the mirror of main/github/'s
// own reader rail. These assertions pin its plan's decisions mechanically.
export default async function ({ expect, fail, ok }: Reporter) {
  const platformDir = 'apps/desktop/src/main/platform';
  const githubDir = 'apps/desktop/src/main/github';
  const writesDir = 'apps/desktop/src/main/writes';
  const commandFile = `${writesDir}/command.ts`;
  const ownershipFile = 'apps/desktop/src/main/dispatch/ownership.ts';
  const typesFile = 'apps/desktop/src/shared/writes/types.ts';
  const coordinationFile = 'docs/COORDINATION.md';

  const srcDir = join(root, 'apps/desktop/src');
  const allFiles = walk(srcDir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
  const writesFiles = allFiles.filter((f) => relOf(f).startsWith(`${writesDir}/`) && !relOf(f).endsWith('.test.ts'));

  if (writesFiles.length === 0) {
    fail('desktop-writes', `${writesDir} has no source files — the guard cannot pass vacuously if the directory is deleted`);
    return;
  }

  // --- '../platform/gh' is imported under apps/desktop/src/ only from main/github/ and
  // main/writes/, and both do import it. The import path is the mechanically checkable fact, since `gh`/`ghJson` are always called through an injected seam. ---
  {
    let sawGithub = false;
    let sawWrites = false;
    // '../platform/gh' also exports `ghAuthStatus`/`classifyGhExit`, legitimately imported
    // anywhere — only an import of `gh` or `ghJson` themselves is this rail's concern.
    const importsGhOrGhJson = /import\s*(?:type\s*)?\{[^}]*\b(?:gh|ghJson)\b[^}]*\}\s*from\s*'\.\.\/platform\/gh'/;
    for (const f of allFiles) {
      const rel = relOf(f);
      if (rel.startsWith(`${platformDir}/`) || rel.endsWith('.test.ts')) continue;
      const text = readFileSync(f, 'utf8');
      if (!importsGhOrGhJson.test(text)) continue;
      if (rel.startsWith(`${githubDir}/`)) {
        sawGithub = true;
      } else if (rel.startsWith(`${writesDir}/`)) {
        sawWrites = true;
      } else {
        fail('desktop-writes', `${rel} imports 'gh'/'ghJson' from '../platform/gh' — only main/github/ and main/writes/ may call gh/ghJson`);
      }
    }
    if (!sawGithub) fail('desktop-writes', `no file under ${githubDir} imports 'gh'/'ghJson' from '../platform/gh' — the guard cannot pass vacuously`);
    if (!sawWrites) fail('desktop-writes', `no file under ${writesDir} imports 'gh'/'ghJson' from '../platform/gh' — the guard cannot pass vacuously`);
    if (sawGithub && sawWrites) ok();
  }

  // --- No file under main/writes/ contains 'graphql' or builds a query — the observed state
  // comes only from fetchItemsByNumber (../github), never a second GraphQL caller. ---
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

  // --- No file under main/writes/ passes merge/close/--delete-branch/ready as a gh
  // subcommand argument — merging and closing stay human actions. ---
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

  // --- --add-label/--remove-label appear only in main/writes/command.ts — a label name must never reach gh without resolving through the vocabulary. ---
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

  // --- .agents/cockpit.json appears in both ownership.ts and COORDINATION.md — the ownership
  // record's path must never diverge between the code and its own contract doc. ---
  {
    const ownershipText = readFileSync(join(root, ownershipFile), 'utf8');
    const coordinationText = readFileSync(join(root, coordinationFile), 'utf8');
    if (!ownershipText.includes("'.agents', 'cockpit.json'")) {
      fail('desktop-writes', `${ownershipFile} does not reference the cockpit.json path`);
    } else expect(coordinationText.includes('.agents/cockpit.json'), 'desktop-writes', `${coordinationFile} does not reference '.agents/cockpit.json'`);
  }

  // --- appendTextFile( is called under apps/desktop/src/ only from main/writes/audit.ts
  // (the write audit log) and main/trajectory/log.ts (the trajectory record) — no third caller may append to anything. ---
  {
    const auditFile = `${writesDir}/audit.ts`;
    const trajectoryFile = 'apps/desktop/src/main/trajectory/log.ts';
    const allowedAppenders = new Set([auditFile, trajectoryFile]);
    let found = false;
    let sawAudit = false;
    let sawTrajectory = false;
    for (const f of allFiles) {
      const rel = relOf(f);
      if (rel.startsWith(`${platformDir}/`)) continue;
      const text = readFileSync(f, 'utf8');
      if (!/\bappendTextFile\s*\(/.test(text)) continue;
      if (rel === auditFile) {
        sawAudit = true;
      } else if (rel === trajectoryFile) {
        sawTrajectory = true;
      } else {
        found = true;
        fail('desktop-writes', `${rel} calls 'appendTextFile(' — only ${[...allowedAppenders].join(' or ')} may append to a log file`);
      }
    }
    if (!sawAudit) fail('desktop-writes', `${auditFile} does not call 'appendTextFile(' — the guard cannot pass vacuously`);
    else if (!sawTrajectory) fail('desktop-writes', `${trajectoryFile} does not call 'appendTextFile(' — the guard cannot pass vacuously`);
    else if (!found) ok();
  }
}

/** Parses a `type X = | { kind: 'a'; f1: T } | ...` block into `Map<kind, Set<fieldName>>`. */
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
