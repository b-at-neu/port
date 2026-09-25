// The only I/O in the forensics engine (#123): resolves the Claude home,
// builds the project index, and reads a session plus its subagent
// transcripts and meta sidecars. Every path is built with node:path, every
// read is bounded, and every failure is a named result — never a thrown
// error a caller has to guess the shape of, since a transcript tree is
// untrusted, partially-written, machine-local state.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseLines } from '../lib/transcript.mjs';

export const DEFAULT_READ_CAP_BYTES = 16 * 1024 * 1024;

const SESSION_ID_CORE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const SESSION_ID_RE = new RegExp(`^${SESSION_ID_CORE}$`, 'i');
const SESSION_ID_FILENAME_RE = new RegExp(`^(${SESSION_ID_CORE})\\.jsonl$`, 'i');
const AGENT_META_SUFFIX = '.meta.json';

/** `--claude-home`, else `CLAUDE_CONFIG_DIR`, else `~/.claude` — never a
 *  hardcoded path, and this is the one place either env var is read. */
export function resolveClaudeHome(explicit) {
  if (typeof explicit === 'string' && explicit !== '') return explicit;
  const fromEnv = process.env.CLAUDE_CONFIG_DIR;
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv;
  return join(homedir(), '.claude');
}

/** Lists `<claudeHome>/projects/` and every project directory beneath it
 *  exactly once, collecting `sessionId -> projectDir` from each
 *  `<uuid>.jsonl` filename — the same ladder apps/desktop/src/main/sessions/
 *  locate.ts uses, so the two never derive a session's location two
 *  different ways. An absent `projects/` is `claude-home-missing`; any
 *  other top-level listing failure is `projects-unreadable`. One
 *  unreadable project directory is skipped, never blinding every other. */
export function buildProjectIndex(claudeHome) {
  const projectsDir = join(claudeHome, 'projects');
  if (!existsSync(projectsDir)) {
    return { ok: false, kind: 'claude-home-missing', message: `${projectsDir} does not exist` };
  }
  let entries;
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true });
  } catch (e) {
    return { ok: false, kind: 'projects-unreadable', message: String(e?.message ?? e) };
  }

  const index = new Map();
  let scannedProjects = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectDir = join(projectsDir, entry.name);
    let children;
    try {
      children = readdirSync(projectDir);
    } catch {
      continue; // one bad project directory never blinds the rest
    }
    scannedProjects += 1;
    for (const child of children) {
      const m = SESSION_ID_FILENAME_RE.exec(child);
      if (m && !index.has(m[1])) index.set(m[1].toLowerCase(), projectDir);
    }
  }
  return { ok: true, index, scannedProjects };
}

/** A bounded, never-throwing read: absent, unreadable, and over-cap are each
 *  a named failure rather than an exception a caller must wrap. */
export function readBounded(path, cap = DEFAULT_READ_CAP_BYTES) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return { ok: false, kind: 'not-found', message: `${path} does not exist` };
  }
  if (stat.size > cap) {
    return { ok: false, kind: 'over-cap', message: `${path} is ${stat.size} bytes, over the ${cap}-byte read cap` };
  }
  try {
    return { ok: true, text: readFileSync(path, 'utf8') };
  } catch (e) {
    return { ok: false, kind: 'unreadable', message: String(e?.message ?? e) };
  }
}

/** The first `cwd` any record in `records` carries — used only to default
 *  `--session` to this repository's own sessions, never to resolve or open
 *  anything (the project index above is what resolves paths). */
export function firstCwdOf(records) {
  for (const raw of records) {
    if (typeof raw === 'object' && raw !== null && typeof raw.cwd === 'string' && raw.cwd !== '') return raw.cwd;
  }
  return null;
}

/** Every session id this Claude home knows about, oldest listing order —
 *  `--since`/no-`--session` both start here. Read-only: this lists what
 *  `buildProjectIndex` already found, it does not re-scan. */
export function listSessionIds(index) {
  return [...index.keys()];
}

/** Reads one session's own transcript plus every subagent transcript and
 *  meta sidecar beside it (`<projectDir>/<sessionId>/subagents/`). Never
 *  throws: a session file or an agent's `.jsonl`/`.meta.json` that fails to
 *  read is recorded in `problems` and skipped, and every other agent in the
 *  same session is still read. Every path is asserted to stay under this
 *  session's own directory before being read, since an `agentId` is
 *  attacker-influenced only through a meta filename this same call already
 *  produced — defense in depth, not the expected path. */
export function readSession(sessionId, projectDir, { cap = DEFAULT_READ_CAP_BYTES } = {}) {
  const sessionPath = join(projectDir, `${sessionId}.jsonl`);
  const problems = [];

  let records = [];
  let malformed = 0;
  const sessionRead = readBounded(sessionPath, cap);
  if (!sessionRead.ok) {
    problems.push({ path: sessionPath, kind: sessionRead.kind, message: sessionRead.message });
  } else {
    const parsed = parseLines(sessionRead.text);
    records = parsed.records;
    malformed = parsed.malformed;
  }

  const sessionDir = join(projectDir, sessionId);
  const subagentsDir = join(sessionDir, 'subagents');
  const agents = [];

  if (existsSync(subagentsDir)) {
    let files;
    try {
      files = readdirSync(subagentsDir);
    } catch (e) {
      problems.push({ path: subagentsDir, kind: 'unreadable', message: String(e?.message ?? e) });
      files = [];
    }

    for (const file of files) {
      if (!file.endsWith(AGENT_META_SUFFIX)) continue;
      const agentId = file.slice(0, -AGENT_META_SUFFIX.length).replace(/^agent-/, '');
      const metaPath = join(subagentsDir, file);
      const metaRead = readBounded(metaPath, cap);
      if (!metaRead.ok) {
        problems.push({ path: metaPath, kind: metaRead.kind, message: metaRead.message });
        continue;
      }
      let meta;
      try {
        meta = JSON.parse(metaRead.text);
      } catch (e) {
        problems.push({ path: metaPath, kind: 'malformed', message: String(e?.message ?? e) });
        continue;
      }
      if (typeof meta?.agentType !== 'string' || meta.agentType === '') {
        problems.push({ path: metaPath, kind: 'malformed', message: 'meta.json is missing a non-empty agentType' });
        continue;
      }

      const jsonlPath = join(subagentsDir, `agent-${agentId}.jsonl`);
      let agentRecords = [];
      let agentMalformed = 0;
      const agentRead = readBounded(jsonlPath, cap);
      if (!agentRead.ok) {
        problems.push({ path: jsonlPath, kind: agentRead.kind, message: agentRead.message });
      } else {
        const parsed = parseLines(agentRead.text);
        agentRecords = parsed.records;
        agentMalformed = parsed.malformed;
      }

      agents.push({
        agentId,
        agentType: meta.agentType,
        description: typeof meta.description === 'string' ? meta.description : null,
        model: typeof meta.model === 'string' ? meta.model : null,
        worktreePath: typeof meta.worktreePath === 'string' ? meta.worktreePath : null,
        worktreeBranch: typeof meta.worktreeBranch === 'string' ? meta.worktreeBranch : null,
        spawnDepth: typeof meta.spawnDepth === 'number' ? meta.spawnDepth : null,
        records: agentRecords,
        malformed: agentMalformed,
      });
    }
  }

  return { sessionId, path: sessionPath, records, malformed, agents, problems };
}
