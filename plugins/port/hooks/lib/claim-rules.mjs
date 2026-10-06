// Pure classifier for the gate-claim file, plus the two denial predicates that consume its
// verdict. Reasons about a JSON file's shape, never a shell command's syntax.
import { labelEditAttempt } from './command-rules.mjs';

const RECOGNIZED_SCOPES = ['plan-gate', 'dispatch'];

/** The three-verdict classifier for the gate-claim file, mirroring the desktop app's own
 *  claim reader. `unreadable` reads as claimed everywhere this is consulted. */
export function classifyGateClaim(exists, text, repo) {
  if (!exists) return { state: 'absent' };

  let value;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { state: 'unreadable', message: `not valid JSON (${e.message})` };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { state: 'unreadable', message: 'not a JSON object' };
  }
  if (typeof value.repo !== 'string' || value.repo !== repo) {
    return { state: 'absent' };
  }
  if (typeof value.owner !== 'string' || typeof value.claimedAt !== 'string') {
    return { state: 'unreadable', message: "missing 'owner' or 'claimedAt'" };
  }

  const rawScopes = Array.isArray(value.scopes) ? value.scopes : [];
  const scopes = rawScopes.filter((s) => RECOGNIZED_SCOPES.includes(s));
  const unknownScopes = rawScopes.filter((s) => typeof s === 'string' && !RECOGNIZED_SCOPES.includes(s));
  return { state: 'held', owner: value.owner, scopes, unknownScopes, claimedAt: value.claimedAt };
}

/** Denies an add/remove of any resolved plan-review label while the claim holds `plan-gate`
 *  (or is unreadable), exempting a subagent or operator-worktree caller. */
export function planGateDenial({ command, who, planGateClaim, planGateLabels }) {
  const claimsPlanGate =
    planGateClaim?.state === 'unreadable' ||
    (planGateClaim?.state === 'held' && (planGateClaim.scopes ?? []).includes('plan-gate'));
  if (!claimsPlanGate || !planGateLabels || who.isSubagent || who.isOperatorWorktree) return null;

  const attempt = labelEditAttempt(command, planGateLabels);
  if (!attempt.isAttempt) return null;

  const names = attempt.matched.join(', ');
  const owner = planGateClaim.state === 'held' ? `claimed by "${planGateClaim.owner}"` : `unreadable (${planGateClaim.message})`;
  return {
    decision: 'deny',
    who,
    subject: command,
    reason: `port: the plan gate is ${owner} — ${names} is denied until the claim is released. Release it in the app, or delete .agents/gate-claim.json, to take the gate back.`,
  };
}

/** Denies an `Agent` call from a cockpit session while the claim holds `dispatch`; exempt
 *  for a subagent and any non-cockpit caller. */
export function dispatchDenial({ toolName, who, isCockpitSession, claim }) {
  if (toolName !== 'Agent' || who?.isSubagent || isCockpitSession !== true) return null;

  const claimsDispatch = claim?.state === 'unreadable' || (claim?.state === 'held' && (claim.scopes ?? []).includes('dispatch'));
  if (!claimsDispatch) return null;

  const owner = claim.state === 'held' ? `claimed by "${claim.owner}"` : `unreadable (${claim.message})`;
  return {
    decision: 'deny',
    who,
    subject: null,
    reason: `port: dispatch is ${owner} — the app dispatches for this checkout, so this cockpit launches no stage agent. Release it in the app, or delete .agents/gate-claim.json, to take dispatch back.`,
  };
}
