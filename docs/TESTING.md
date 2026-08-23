# Testing the plugin

This plugin is almost entirely prompts, which makes it easy to change confidently and wrongly. Three layers, deliberately separated by cost.

## Layer 1 — static checks

```bash
node scripts/checks.mjs
```

No dependencies, no plugin install, no model calls. Runs in seconds, in CI on every pull request, and in an agent's worktree before it pushes.

**These guard against silence.** A skill or agent whose frontmatter is malformed is *absent* from Claude Code's component inventory rather than reported as an error, so nothing complains — the component simply is not there. Same for a hook. Every check below exists because something broke that way:

| Check | Guards against |
| --- | --- |
| Frontmatter parses, has `name` and `description`, and `name` matches its path | A component silently missing from the inventory |
| `hooks.json` `command` is a shell string, not an argv array | The hook loading as `Hooks (0)` — no error, just absent |
| Templates and manifests are valid JSON | Anything downstream reading `undefined` |
| Label keys in `labels.json` match the schema exactly, both directions | Two files listing the same vocabulary and drifting |
| Every label `color` is a well-formed hex, and no two labels share one | A role's ramp collapsing back to one repeated hex |
| `commands.checks` entries are `{run, fix}` objects | Bare strings, which parse fine and read plausibly while every consumer gets `undefined` |
| Stale references — the former installer name, the former config location, unprefixed skill names | Docs naming things that were renamed or moved |

Each rule is worth testing by breaking it deliberately. If a check cannot be made to fail, it is not a check.

The script reports full schema validation as **skipped**, because a draft 2020-12 validator is a dependency and the script must run where none is installed. CI does that part.

## Layer 2 — artifact assertions on real runs

Once this repository runs its own pipeline, every real run is a live fixture. Rather than a sandbox repository or a stubbed `gh`, assert on what the pipeline actually produced.

This targets a real exposure: the output formats live in `PIPELINE.md` and are asserted nowhere. The one that matters most is the review heading — the cockpit **counts** occurrences of the literal `## Code Review` to derive the cycle number, so renaming it silently breaks the cycle cap and the escalating bar, with no error anywhere.

## Layer 3 — behavioural evals

Static checks cannot tell you whether a prompt *works* — whether the model actually refuses to edit source, or presents the rule set before writing. That needs running it.

`claude plugin eval` is built for exactly this: `evals/**/case.yaml` with graders, `--runs` for variance, `--threshold` for a CI exit code, and **`--ablation with-without`**, which runs a no-plugin baseline arm and reports the score delta — the only thing that answers "is this prompt doing anything at all".

It is currently **early-access gated**. Until access lands, cases are authored anyway: they are just files, and writing them forces you to say what each prompt is actually supposed to guarantee.

**When they run:** manually while iterating on a prompt, and in CI only on pull requests touching `agents/**` or `skills/**`.

**Never in `commands.checks`.** That list is what `impl-agent` runs before pushing, so evals there would mean every dispatched agent spawning its own model runs — recursive, slow, and paid for on every ticket.
