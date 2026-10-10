# Repository guidance

## Context

- Read `CONTEXT.md` when defining or changing agent terminology.
- Before changing user-facing behavior, read the relevant guide linked from `README.md`. Use it to identify the existing contract, and update it if the requested behavior changes that contract.
- For agent discovery or configuration changes, read `docs/agent-definitions.md` and `docs/subagent-overrides.md`. Check both execution and agent listings against the same resolution and validation rules.
- For web request or content conversion changes, read `docs/web-search.md` and its linked ADR. Preserve the documented destination checks, download limits, cancellation, and source-trust rules unless the requested change explicitly revises them.

## Test-driven development

For every coding task that adds or changes executable behavior, load and follow the `tdd` skill before implementation. If the skill is unavailable or a meaningful executable test is blocked, stop and report the blocker before continuing.

Skip TDD for discovery, documentation, compatibility audits, and repository maintenance that do not change executable behavior. Run checks appropriate to that work.

## Completion

Use `package.json` for check commands and `.github/workflows/quality.yml` for the CI check set. Prefer check-only commands during verification. Formatting and lint fix commands can modify files outside the task.

For executable changes, run the CI check set after the final edit. For documentation-only changes, check formatting and verify each new path or link. Report each command and result, and explain any check you could not run.
