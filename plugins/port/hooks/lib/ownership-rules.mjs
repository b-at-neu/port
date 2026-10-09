// Pure classifier for the cockpit-ownership file, plus the two denial predicates that consume
// its verdict. Reasons about a JSON file's shape, never a shell command's syntax.

const RECOGNIZED_OWNERS = ['app', 'terminal'];

/** The four-verdict classifier for `.agents/cockpit.json`, mirroring the desktop app's own
 *  classifier field for field — a JSON array falls through to `absent`, same as a missing `repo`. */
export function classifyOwnership(exists, text, repo) {
  if (!exists || text === null) return { kind: 'absent' };

  let value;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { kind: 'unreadable', message: e.message };
  }
  if (typeof value !== 'object' || value === null) {
    return { kind: 'unreadable', message: 'cockpit.json is not a JSON object' };
  }
  if (typeof value.repo !== 'string' || value.repo !== repo) {
    return { kind: 'absent' };
  }
  if (typeof value.since !== 'string') {
    return { kind: 'unreadable', message: "cockpit.json is missing 'since'" };
  }
  if (!RECOGNIZED_OWNERS.includes(value.owner)) {
    return { kind: 'unreadable', message: "cockpit.json has an unknown 'owner'" };
  }
  return { kind: value.owner, since: value.since };
}

/** Denies an `Agent` call from a cockpit session while this app owns the repository, or while
 *  ownership can't be read — exempt for a subagent and any non-cockpit caller. */
export function dispatchDenial({ toolName, who, isCockpitSession, ownership }) {
  if (toolName !== 'Agent' || who?.isSubagent || isCockpitSession !== true) return null;

  const appOwnsItOrUnknown = ownership?.kind === 'app' || ownership?.kind === 'unreadable';
  if (!appOwnsItOrUnknown) return null;

  const owner =
    ownership.kind === 'app' ? `port-desktop runs this repo (since ${ownership.since})` : `.agents/cockpit.json can't be read (${ownership.message})`;
  return {
    decision: 'deny',
    who,
    subject: null,
    reason: `port: ${owner} — this cockpit launches no stage agent while that holds. Pause the repo in the app, or fix .agents/cockpit.json, to take it back.`,
  };
}

/** Denies a `Write`/`Edit`/`NotebookEdit` to `.agents/cockpit.json` for every caller, with one
 *  exception: a cockpit session's `Write` taking ownership (`absent`/`terminal` → `terminal`). */
export function cockpitWriteDenial({ toolName, who, filePath, cockpitFilePath, isCockpitSession, content, repo, currentOwnership }) {
  if (!cockpitFilePath || typeof filePath !== 'string' || filePath.length === 0 || filePath !== cockpitFilePath) return null;

  if (toolName === 'Write' && isCockpitSession === true && typeof content === 'string') {
    const written = classifyOwnership(true, content, repo);
    const verdictAllowsTakeover = currentOwnership?.kind === 'absent' || currentOwnership?.kind === 'terminal';
    if (written.kind === 'terminal' && verdictAllowsTakeover) return null;
  }

  return {
    decision: 'deny',
    who,
    subject: filePath,
    reason:
      "port: .agents/cockpit.json is written only by the app's own main process, or by a terminal cockpit taking ownership at its own preflight — no other session or agent may write to it, including from an operator worktree.",
  };
}
