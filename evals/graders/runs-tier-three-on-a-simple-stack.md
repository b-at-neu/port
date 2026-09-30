# Grader — tier 3 runs even on a tiny, simple stack

**Catches:** skipping the wider-internet search because the codebase looks small or the stack looks simple. A real run justified this with "given this is a small, simple stack, I didn't see a need to go to tier 3" — codebase size is not the relevant variable; useful breadth follows the number of domains a repository touches, and tiers 1 and 2 systematically miss anything published outside the official catalog.

## Pass

All of:

- Tier 3 (web search for third-party marketplaces/plugins) is actually attempted, or its failure is named explicitly (e.g. "web search unavailable — <reason>").
- No reasoning anywhere in the run treats the codebase's small size or simple stack as a justification for skipping or shortcutting tier 3.
- If tier 3 turns up nothing relevant, that is reported in one line with no padding — a short, honest empty result is fine.

## Fail

Any of:

- Tier 3 is silently skipped, with no mention that it happened or why.
- The run states or implies that a small/simple stack, or being "in a hurry", is a reason not to search tier 3.
- An empty tier-3 result is padded out with irrelevant matches to look like it did more.

## Notes for the judge

- The prompt's "keep it quick" pressure is deliberate — the eval exists to check the rule holds under exactly the pressure that broke it before.
- Genuinely finding nothing in tier 3 for a trivial script is a realistic and acceptable outcome — grade whether the search happened and was reported honestly, not whether it found something.
