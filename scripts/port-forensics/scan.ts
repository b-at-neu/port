// The only I/O in the forensics engine: resolves the Claude home, builds the project index,
// and reads a session plus its subagent transcripts. Every failure is a named result, never a thrown error — a transcript tree is untrusted, partially-written state.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { parseLines } from '../lib/transcript.ts';

export const DEFAULT_READ_CAP_BYTES = 16 * 1024 * 1024;

const SESSION_ID_CORE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const SESSION_ID_RE = new RegExp(`^${SESSION_ID_CORE}$`, 'i');
const SESSION_ID_FILENAME_RE = new RegExp(`^(${SESSION_ID_CORE})\\.jsonl$`, 'i');
const AGENT_META_SUFFIX = '.meta.json';

/** `--claude-home`, else `CLAUDE_CONFIG_DIR`, else `~/.claude` — the one place either env var is read. */
export function resolveClaudeHome(explicit: string | undefined): string {
  if (typeof explicit === 'string' && explicit !== '') return explicit;
  const fromEnv = process.env.CLAUDE_CONFIG_DIR;
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv;
  return join(homedir(), '.claude');
}

/** Lists `<claudeHome>/projects/` and collects `sessionId -> projectDir` from each
 *  `<uuid>.jsonl` filename. An absent `projects/` is `claude-home-missing`; one unreadable project directory is skipped, never blinding every other. */
export function buildProjectIndex(claudeHome: string): any {
  const projectsDir = join(claudeHome, 'projects');
  if (!existsSync(projectsDir)) {
    return { ok: false, kind: 'claude-home-missing', message: `${projectsDir} does not exist` };
  }
  let entries;
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true });
  } catch (e: any) {
    return { ok: false, kind: 'projects-unreadable', message: String(e?.message ?? e) };
  }

  const index = new Map<string, string>();
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
export function readBounded(path: string, cap = DEFAULT_READ_CAP_BYTES): any {
  let stat: any;
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
  } catch (e: any) {
    return { ok: false, kind: 'unreadable', message: String(e?.message ?? e) };
  }
}

/** The first `cwd` any record in `records` carries — used only to default `--session`, never to resolve or open anything. */
export function firstCwdOf(records: any[]): string | null {
  for (const raw of records) {
    if (typeof raw === 'object' && raw !== null && typeof raw.cwd === 'string' && raw.cwd !== '') return raw.cwd;
  }
  return null;
}

/** True when `child`, once resolved, is `parent` itself or nested under it — the containment rail before reading any untrusted path. */
function isContainedIn(child: string, parent: string): boolean {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  return resolvedChild === resolvedParent || resolvedChild.startsWith(resolvedParent + sep);
}

/** Every session id this Claude home knows about. Read-only: lists what `buildProjectIndex` already found, does not re-scan. */
export function listSessionIds(index: Map<string, string>): string[] {
  return [...index.keys()];
}

/** Reads one session's own transcript plus every subagent transcript and meta sidecar beside
 *  it. Never throws: a file that fails to read is recorded in `problems` and skipped. Every path is asserted to stay under this session's own directory before being read. */
export function readSession(sessionId: string, projectDir: string, { cap = DEFAULT_READ_CAP_BYTES }: { cap?: number } = {}): any {
  const sessionPath = join(projectDir, `${sessionId}.jsonl`);
  const problems: any[] = [];

  let records: any[] = [];
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
  const agents: any[] = [];

  if (existsSync(subagentsDir)) {
    let files: string[];
    try {
      files = readdirSync(subagentsDir);
    } catch (e: any) {
      problems.push({ path: subagentsDir, kind: 'unreadable', message: String(e?.message ?? e) });
      files = [];
    }

    for (const file of files) {
      if (!file.endsWith(AGENT_META_SUFFIX)) continue;
      const agentId = file.slice(0, -AGENT_META_SUFFIX.length).replace(/^agent-/, '');
      const metaPath = join(subagentsDir, file);
      if (!isContainedIn(metaPath, subagentsDir)) {
        problems.push({ path: metaPath, kind: 'unsafe-path', message: `${metaPath} escapes ${subagentsDir}` });
        continue;
      }
      const metaRead = readBounded(metaPath, cap);
      if (!metaRead.ok) {
        problems.push({ path: metaPath, kind: metaRead.kind, message: metaRead.message });
        continue;
      }
      let meta: any;
      try {
        meta = JSON.parse(metaRead.text);
      } catch (e: any) {
        problems.push({ path: metaPath, kind: 'malformed', message: String(e?.message ?? e) });
        continue;
      }
      if (typeof meta?.agentType !== 'string' || meta.agentType === '') {
        problems.push({ path: metaPath, kind: 'malformed', message: 'meta.json is missing a non-empty agentType' });
        continue;
      }

      const jsonlPath = join(subagentsDir, `agent-${agentId}.jsonl`);
      if (!isContainedIn(jsonlPath, subagentsDir)) {
        problems.push({ path: jsonlPath, kind: 'unsafe-path', message: `${jsonlPath} escapes ${subagentsDir}` });
        continue;
      }
      let agentRecords: any[] = [];
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
