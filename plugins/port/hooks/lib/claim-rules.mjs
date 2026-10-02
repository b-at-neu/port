// Pure classifier for the gate-claim file (#206, #265) — split out of
// guard-rules.mjs so that file stays under the 500-line ratchet rather than
// absorbing a fourth concern (caller identity, settings/transcript I/O,
// command-syntax predicates, and now claim classification) into one module.
// Kept separate from command-rules.mjs too: this reasons about a JSON file's
// shape, never a shell command's syntax, so it does not belong in that
// module's own stated scope either. Also holds the two denial predicates
// that consume the classified verdict — `planGateDenial` (moved here
// verbatim from guard-rules.mjs, #265) and `dispatchDenial` (#265, new) —
// since both reason about claim scopes rather than command syntax either.
import { labelEditAttempt } from './command-rules.mjs';

const RECOGNIZED_SCOPES = ['plan-gate', 'dispatch'];

/** The three-verdict classifier for the gate-claim file, mirroring the
 *  desktop app's own claim reader field-for-field so both sides of every
 *  claimed scope agree on what the same bytes mean. Pure — `exists` and
 *  `text` are already-read by the caller, never a filesystem call here.
 *  `absent` is a positive determination (no claim on this repository),
 *  never ambiguity: a `repo` that names a different repository reads as
 *  `absent`, the same as the file not existing at all. `unreadable`
 *  (unparseable, not an object, or missing `owner`/`claimedAt`) reads as
 *  claimed everywhere this verdict is consulted — a malformed claim's only
 *  ambiguity is which writer owns which scope, and standing every scope's
 *  writers down is the one reading that cannot produce an unintended
 *  decision. `owner` is read for report text only, never as liveness.
 *  `plan-gate` and `dispatch` are the two recognized scopes; anything else
 *  lands in `unknownScopes`, reported but never denied on. */
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

/** The plan-gate claim rule (#206), moved verbatim out of `guard-rules.mjs`'s
 *  `decide` — forced by that file sitting at 497/500 lines, behaviour
 *  identical to what it replaced. Denies an add/remove of any resolved
 *  `planReview`/`planApproved`/`planChangesRequested` label while the claim
 *  holds `plan-gate` (or is unreadable), for a non-subagent,
 *  non-operator-worktree caller — `plan-agent`/`impl-agent` write these same
 *  labels at handoff, and `/port:implement` needs the same exemption for the
 *  same reason a rule that fired there would deadlock the pipeline the
 *  instant a claim is taken. Returns `null` when the rule does not apply, so
 *  `decide` falls through to its next rule. */
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

/** The dispatch claim rule (#265) — the `Agent` tool's own arm, mirroring
 *  `planGateDenial`'s shape for the second claimed scope. Denies an
 *  `Agent` call from a cockpit session while the claim holds `dispatch` (or
 *  is unreadable) — the app dispatches for this checkout instead, so the
 *  cockpit must launch no stage agent. No agent-name list: the cockpit
 *  launches nothing else through this tool. Exempt for a subagent (stage
 *  agents already declare `disallowedTools: Agent`, so this is defense in
 *  depth) and for any caller whose `isCockpitSession` is not `true` —
 *  `false` (an ordinary operator session) and `null` (an unreadable
 *  transcript) both allow, the same fail-open direction the branch rule
 *  takes on an unknowable identity; the app's own dispatcher session is
 *  never a cockpit session, so it is never denied here either. */
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
