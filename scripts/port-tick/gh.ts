// The only I/O in the engine. Spawns `gh api graphql --include` with an explicit argv array
// (never `shell: true`), classifies nothing itself — envelope.ts reads what comes back.
import { spawnSync } from 'node:child_process';

/** Runs `gh api graphql --include`. `--include` puts the `Date:` header on stdout — the only
 *  clock this engine has. `ok` is false only when no JSON body could be parsed at all. */
export function runGraphql(query: string): any {
  const res = spawnSync('gh', ['api', 'graphql', '--include', '-F', `query=${query}`], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });

  if (res.error) {
    return { ok: false, headers: {}, body: null, exitCode: null, error: String(res.error.message ?? res.error) };
  }

  const raw = res.stdout ?? '';
  const splitAt = raw.indexOf('\r\n\r\n') !== -1 ? raw.indexOf('\r\n\r\n') + 4 : raw.indexOf('\n\n') + 2;
  const headerBlock = splitAt > 1 ? raw.slice(0, splitAt) : '';
  const jsonText = splitAt > 1 ? raw.slice(splitAt) : raw;

  const headers: Record<string, string> = {};
  for (const line of headerBlock.split(/\r?\n/)) {
    const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (m) headers[m[1].toLowerCase()] = m[2].trim();
  }

  let body = null;
  try {
    body = JSON.parse(jsonText);
  } catch {
    const stderrText = (res.stderr ?? '').trim().split('\n')[0] ?? '';
    return { ok: false, headers, body: null, exitCode: res.status, error: stderrText || 'gh api graphql produced no parseable JSON body' };
  }

  return { ok: true, headers, body, exitCode: res.status };
}
