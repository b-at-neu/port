#!/usr/bin/env node
// Vendor-neutral ticket creation for /port:scope, self-contained. Verbs take ticket keys, never
// vendor identifiers; the backend is chosen from `tracker` in .claude/port.config.json.
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = `usage:
  tracker.mjs create --title "<title>" --body-file <path>
  tracker.mjs link-child --parent <key> --child <key>
  tracker.mjs block --blocked <key> --by <key>`;

const BLOCK_MUTATION =
  'mutation($issueId: ID!, $blockingIssueId: ID!) { addBlockedBy(input: { issueId: $issueId, blockingIssueId: $blockingIssueId }) { clientMutationId } }';

class TrackerError extends Error {}

/** Accepts `#123` or `123`; returns the number, or null for anything else. */
export function parseKey(text) {
  const m = /^#?([1-9]\d*)$/.exec(String(text ?? '').trim());
  return m ? Number(m[1]) : null;
}

/** Reads the issue number off the last non-blank line `gh issue create` printed. */
export function issueNumberFromUrl(stdout) {
  const lines = String(stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const m = /\/issues\/(\d+)$/.exec(lines.at(-1) ?? '');
  return m ? Number(m[1]) : null;
}

/** The failure in a GraphQL envelope, or null when the call succeeded. Read stdout whatever gh's exit status. */
export function graphqlFailure(stdout) {
  let body;
  try {
    body = JSON.parse(stdout);
  } catch {
    return 'unparsable response';
  }
  const first = body?.errors?.[0]?.message;
  if (first) return first;
  if (!body?.data?.addBlockedBy) return 'no data';
  return null;
}

function defaultRun(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  if (r.error) return { status: null, stdout: '', stderr: r.error.code === 'ENOENT' ? 'ENOENT' : String(r.error.message) };
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function createGithubBackend({ repo, run }) {
  const gh = (verb, args) => {
    const r = run('gh', args);
    if (r.stderr === 'ENOENT' && r.status === null) throw new TrackerError('`gh` is not on PATH');
    return { ...r, verb };
  };
  const ghOk = (verb, args) => {
    const r = gh(verb, args);
    if (r.status !== 0) {
      const line = (r.stderr || r.stdout).split('\n').find((l) => l.trim()) ?? `exit ${r.status}`;
      throw new TrackerError(`gh ${verb} — ${line.trim()}`);
    }
    return r;
  };
  const issueField = (number, field) => {
    const r = ghOk('api', ['api', `repos/${repo}/issues/${number}`]);
    let value;
    try {
      value = JSON.parse(r.stdout)[field];
    } catch {
      value = undefined;
    }
    if (value === undefined || value === null) throw new TrackerError(`gh api — issue #${number} has no ${field}`);
    return String(value);
  };

  return {
    createIssue({ title, bodyFile }) {
      const r = ghOk('issue create', ['issue', 'create', '--repo', repo, '--title', title, '--body-file', bodyFile]);
      const number = issueNumberFromUrl(r.stdout);
      if (number === null) {
        const line = r.stdout.split('\n').filter((l) => l.trim()).at(-1) ?? '';
        throw new TrackerError(
          `created an issue but could not read its number from gh's output — check ${repo} before re-running, or you'll get a duplicate: ${line}`,
        );
      }
      return { key: `#${number}`, url: r.stdout.trim().split('\n').filter(Boolean).at(-1) };
    },
    linkChild({ parent, child }) {
      const id = issueField(child, 'id');
      ghOk('api', ['api', `repos/${repo}/issues/${parent}/sub_issues`, '-X', 'POST', '-F', `sub_issue_id=${id}`]);
    },
    addBlockedBy({ blocked, by }) {
      const issueId = issueField(blocked, 'node_id');
      const blockingIssueId = issueField(by, 'node_id');
      const r = gh('api graphql', ['api', 'graphql', '-f', `query=${BLOCK_MUTATION}`, '-f', `issueId=${issueId}`, '-f', `blockingIssueId=${blockingIssueId}`]);
      const failure = graphqlFailure(r.stdout);
      if (failure) throw new TrackerError(`gh api graphql — ${failure}`);
    },
  };
}

export const BACKENDS = { github: createGithubBackend };

/** The backend for `cfg.tracker` (default github), or `{ error }` for a vendor with none. */
export function backendFor(cfg, run) {
  const vendor = cfg.tracker ?? 'github';
  const factory = BACKENDS[vendor];
  if (!factory) return { error: `tracker '${vendor}' has no backend in this script — supported: ${Object.keys(BACKENDS).join(', ')}` };
  return { backend: factory({ repo: cfg.repo, run }) };
}

function findRoot(startDir) {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, '.claude/port.config.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function flags(argv, names) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]?.replace(/^--/, '');
    if (!argv[i]?.startsWith('--') || !names.includes(name) || argv[i + 1] === undefined) throw new TrackerError(`bad argument '${argv[i] ?? ''}'\n${USAGE}`);
    out[name] = argv[i + 1];
  }
  for (const n of names) if (out[n] === undefined) throw new TrackerError(`missing --${n}\n${USAGE}`);
  return out;
}

function key(text, flag) {
  const n = parseKey(text);
  if (n === null) throw new TrackerError(`--${flag} '${text}' is not a ticket key — expected #123`);
  return n;
}

export function execute(argv, cfg, run) {
  const [verb, ...rest] = argv;
  if (!['create', 'link-child', 'block'].includes(verb ?? '')) throw new TrackerError(USAGE);
  const names = { create: ['title', 'body-file'], 'link-child': ['parent', 'child'], block: ['blocked', 'by'] }[verb];
  const f = flags(rest, names);
  const keys = verb === 'create' ? {} : { a: key(f[names[0]], names[0]), b: key(f[names[1]], names[1]) };
  if (!cfg.repo) throw new TrackerError('.claude/port.config.json has no `repo`');
  const { backend, error } = backendFor(cfg, run);
  if (error) throw new TrackerError(error);
  if (verb === 'create') {
    const made = backend.createIssue({ title: f.title, bodyFile: f['body-file'] });
    return `ok    created ${made.key} ${made.url}`;
  }
  if (verb === 'link-child') {
    backend.linkChild({ parent: keys.a, child: keys.b });
    return `ok    linked #${keys.b} under #${keys.a}`;
  }
  backend.addBlockedBy({ blocked: keys.a, by: keys.b });
  return `ok    #${keys.a} blocked by #${keys.b}`;
}

function main() {
  const argv = process.argv.slice(2);
  try {
    if (argv.length === 0) {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    const root = findRoot(process.cwd());
    if (!root) throw new TrackerError('.claude/port.config.json was not found in this or any parent directory — this repository is not port-managed.');
    const cfg = JSON.parse(readFileSync(join(root, '.claude/port.config.json'), 'utf8'));
    process.stdout.write(`${execute(argv, cfg, defaultRun)}\n`);
  } catch (e) {
    if (!(e instanceof TrackerError)) throw e;
    process.stdout.write(`FAIL  ${e.message}\n`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
