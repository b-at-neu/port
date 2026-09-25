// Pure classifier for the plan-gate claim file (#206) — split out of
// guard-rules.mjs so that file stays under the 500-line ratchet rather than
// absorbing a fourth concern (caller identity, settings/transcript I/O,
// command-syntax predicates, and now claim classification) into one module.
// Kept separate from command-rules.mjs too: this reasons about a JSON file's
// shape, never a shell command's syntax, so it does not belong in that
// module's own stated scope either.

/** The three-verdict classifier for a `plan-gate` claim file, mirroring the
 *  desktop app's own claim reader field-for-field so both sides of the gate
 *  agree on what the same bytes mean. Pure — `exists` and `text` are
 *  already-read by the caller, never a filesystem call here. `absent` is a
 *  positive determination (no claim on this repository), never ambiguity: a
 *  `repo` that names a different repository reads as `absent`, the same as
 *  the file not existing at all. `unreadable` (unparseable, not an object,
 *  or missing `owner`/`claimedAt`) reads as claimed everywhere this verdict
 *  is consulted — a malformed claim's only ambiguity is which writer owns
 *  the gate, and standing both down is the one reading that cannot produce
 *  an unintended decision. `owner` is read for report text only, never as
 *  liveness. Only `plan-gate` is a recognized scope; anything else lands in
 *  `unknownScopes`, reported but never denied on. */
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
  const scopes = rawScopes.filter((s) => s === 'plan-gate');
  const unknownScopes = rawScopes.filter((s) => typeof s === 'string' && s !== 'plan-gate');
  return { state: 'held', owner: value.owner, scopes, unknownScopes, claimedAt: value.claimedAt };
}
