# port.config.json schema

`port.config.schema.json` defines the per-repository configuration the pipeline reads. Each managed repository commits its own `.claude/port.config.json`; the installer writes it from `plugins/port/templates/port.config.json`.

Only `repo` is required. Every other key has a default recorded in the schema — but `default` in JSON Schema is documentation, not behaviour: nothing populates a missing value, so each agent and skill applies the defaults itself.

## Validating

`fixtures/` holds configs that must pass and configs that must fail, so a schema change that quietly stops rejecting bad input gets caught.

```bash
python3 -m jsonschema -i schema/fixtures/valid.portfolio.json schema/port.config.schema.json
```

Any draft 2020-12 validator works; the fixtures carry no tool-specific content. Wiring this up as a repeatable check belongs to the ticket that configures this repository's own pipeline.

| Fixture | Asserts |
| --- | --- |
| `valid.minimal.json` | `{ "repo": "..." }` alone is a complete config |
| `valid.portfolio.json` | A single-check, no-engineering-doc repository validates |
| `valid.aplio.json` | Multiple checks with fix commands, the optional module on, and extra allow patterns validate |
| `invalid.missing-repo.json` | `repo` is required |
| `invalid.bad-repo.json` | `repo` is `owner/name`, not a URL |
| `invalid.unknown-tracker.json` | Only implemented trackers are accepted |
| `invalid.unknown-key.json` | A misspelled key is an error, not silently ignored |
| `invalid.check-missing-run.json` | A check without a command is an error |
