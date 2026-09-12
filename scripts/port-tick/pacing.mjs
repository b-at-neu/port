// Pure: the pacing ladder, per plugins/port/skills/pipeline/SKILL.md →
// "Pacing". Floor with no backoff whenever something will move without a
// human; otherwise back off one rung per consecutive no-change tick,
// resetting to the floor unconditionally on any observed change.
export const LADDER = [270, 540, 1080, 1800];

/** `cadenceStep` is the rung index (0 = floor) this tick started at.
 *  `willMoveWithoutHuman` — an agent in flight, or an item about to
 *  dispatch. `observedChange` — a new trigger label, a merge, a completion,
 *  a gate answered, or the resumed-after-a-gap condition; resets the ladder
 *  even on an otherwise "no-change" tick. Returns `{ delay, cadenceStep }`
 *  for the *next* tick to start from. */
export function nextDelay(cadenceStep, { willMoveWithoutHuman, observedChange }) {
  if (willMoveWithoutHuman || observedChange) return { delay: LADDER[0], cadenceStep: 0 };
  const step = Math.min(cadenceStep + 1, LADDER.length - 1);
  return { delay: LADDER[step], cadenceStep: step };
}
