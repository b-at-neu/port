# Behavioural evals — layer 3

Static checks tell you a prompt *parsed*. They cannot tell you it *works* — that the model actually refuses to edit source, or presents the rule set before writing. That needs running it, which costs money, so this layer is deliberate and separate. See [docs/TESTING.md](../docs/TESTING.md) for how the three layers divide.

## Running

The whole suite, against the installed plugin:

```bash
claude plugin eval port@port --scaffold
```

One case:

```bash
claude plugin eval port@port --scaffold --case analyze-refuses-to-edit-source
```

All the `/port:init` cases:

```bash
claude plugin eval port@port --scaffold --tag init
```

`--scaffold` is required and off by default, because each case's `scaffold_script` is author-supplied bash that runs as you. Read a case before running it.

Two flags matter more than the rest:

- **`--ablation with-without`** runs a no-plugin baseline arm and reports the score delta. It is the only thing that answers *is this prompt doing anything at all* — a case the base model passes unaided is measuring nothing. It is the default whenever a plugin resolves.
- **`--runs <n>`** (default 3) runs each case repeatedly, because a single sample of a model is not a measurement.

`--threshold <0..1>` turns the run into a CI exit code and defaults to `1.0`.

## Status: early access

Every `claude plugin eval` subcommand currently reports, verbatim:

```
`plugin eval` is currently in early access
```

`claude plugin eval --help` is the exception — it prints the full flag reference without hitting the gate, which is where the schema below comes from.

So nothing here runs yet on this account. The cases exist anyway, and that is not a placeholder: writing a case forces you to say what a prompt is actually supposed to guarantee, and each one below is a defect that escaped to a real run precisely because nobody had written that sentence down. Requesting early access, and recording the outcome, is tracked on issue #55.

## The case schema, and where it came from

**Provisional.** It is assembled from `claude plugin eval --help`, not from a documented schema or a generated template — `claude plugin eval init --bare` would produce the authoritative shape but is itself gated. Recording the provenance is what keeps the eventual correction a rename rather than a rewrite.

| Key | Provenance | Notes |
| --- | --- | --- |
| `name` | `--case <glob>` filters cases by name | Matches the directory name here, so the two never drift |
| `tags` | `--tag <tag...>`, repeatable | |
| `runs` | `--runs` documents its default as `case.runs ?? 3` | Confirmed: the case may set it |
| `prompt` | `<eval dir>/**/case.yaml or prompt.md + graders/*.md` | Inline here rather than a sibling `prompt.md` |
| `graders` | same | A list of file names under `graders/` |
| `scaffold_script` | `--scaffold` / `--no-scaffold` describe "each case's `scaffold_script`" | Bash, run as you |
| `max_turns`, `timeout_seconds` | "runs are already bounded by `max_turns` and `timeout_seconds`" | Named, defaults unknown |

One documented grader form is **not** used here yet: `--ablation` mentions graders marked `with-only`, including `tool_used: Skill`, which act as a plugin-fired indicator rather than part of the score. That is the right way to assert the skill actually triggered, and is worth adding once the shape can be verified against a real run.

`scripts/checks.mjs` checks what is statically knowable about these files — every case declares `name`, `prompt` and `graders`, every named grader resolves to a file, and every grader file is referenced by at least one case. That runs for free on every pull request, with no API key and no early access, so a case broken by a rename is caught immediately rather than whenever the gate lifts.

## The cases

| Case | Regression target | Behaviour |
| --- | --- | --- |
| `analyze-refuses-to-edit-source` | #43 | Handed an obvious one-line fix and asked to make it, `/port:analyze` declines and says why |
| `analyze-presents-rules-before-writing` | #43 | The whole document is shown before anything is written; abandoning leaves nothing on disk |
| `analyze-surfaces-user-scope-plugin` | #50 | A user-scope-only install is a declare-at-project-scope candidate, not a duplicate to exclude |
| `init-stops-on-unallowlisted-check` | #53 | `/port:init` will not write a check the allowlist forbids — it narrows the allowlist or drops the check, deliberately |
| `init-preserves-enabled-plugins` | #47 | Merging settings keeps `enabledPlugins`, `extraKnownMarketplaces`, `hooks` and `env` intact |
| `plan-marks-operator-only-test-step` | #118 | A plan whose only `.claude/**` reference is a testing step is never declared plainly dispatchable — it is marked `SESSION REQUIRED` or that step is marked operator-only |
| `pipeline-resolves-label-vocabulary` | #61 | The cockpit resolves every `--label` argument to a real label name — honouring a partial config override and every unoverridden default — never a bare config key |
| `cockpit-relabels-many-items` | #120 | Pressed to relabel four stuck issues fast, the cockpit batches (or issues one call per item) and re-queries — never a shell loop wrapping `gh` |
| `cockpit-holds-needs-human-gate` | #138 | Pressed to unstick a pipeline that "looks stuck," the cockpit never clears a `needs human` gate the operator never named — it announces and offers `unblock #N` instead |

`analyze-surfaces-user-scope-plugin` is tagged `known-failing` and **is expected to fail** against the current prompt, which still excludes anything already installed with no scope distinction. Issue #50 is the fix. A regression target written before its fix is the point of the tag, not an oversight — remove the tag when #50 lands.

## Writing a case

- **One behaviour per case.** If a grader needs "and", it is two cases.
- **Apply pressure.** A rule is only worth testing where following it costs something, which is why the refuse-to-edit case explicitly asks for the fix.
- **Grade the artifact, not the narration.** A run that announces the right thing and does the wrong thing must fail; every grader here says so explicitly.
- **Name the failure the grader exists to catch,** at the top. A grader whose purpose has to be reconstructed from its pass conditions gets loosened the first time it is inconvenient.
- **Never add these to `commands.checks`.** That list is what `impl-agent` runs before pushing, so an eval there means every dispatched agent spawning its own model runs — recursive, slow, and paid for on every ticket. `scripts/checks.mjs` enforces this mechanically.
