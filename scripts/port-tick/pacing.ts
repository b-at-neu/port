// Pure: the pacing ladder. Floor with no backoff whenever something will move without a
// human; otherwise back off one rung per no-change tick, resetting to floor on any observed change.
export const LADDER = [270, 540, 1080, 1800];

/** `cadenceStep` is the rung index (0 = floor) this tick started at. `observedChange`
 *  resets the ladder even on an otherwise "no-change" tick. Returns the next tick's state. */
export function nextDelay(
  cadenceStep: number,
  { willMoveWithoutHuman, observedChange }: { willMoveWithoutHuman: boolean; observedChange: boolean },
): { delay: number; cadenceStep: number } {
  if (willMoveWithoutHuman || observedChange) return { delay: LADDER[0], cadenceStep: 0 };
  const step = Math.min(cadenceStep + 1, LADDER.length - 1);
  return { delay: LADDER[step], cadenceStep: step };
}
