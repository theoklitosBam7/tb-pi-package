## Summary

<!-- 2-3 sentences describing what this PR does and why -->

## Type of Change

- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Refactor
- [ ] Documentation
- [ ] Dependencies / tooling
- [ ] Extension
- [ ] Agent
- [ ] Prompt / skill
- [ ] Workflow
- [ ] Test

## Example Output

<!-- Paste pi session snippets, tool output, or before/after agent behavior if applicable. Skip if dependency-only. -->

## Test Procedure

<!-- How was this tested? What should reviewers look for? For deps-only PRs: run checks below and note any engine or runtime minimum changes. -->

- [ ] `pnpm fmt`, `pnpm lint:fix`, and `pnpm typecheck` pass
- [ ] Tested in pi (install method: global / local / session) — skip if dependency-only
- [ ] Manual testing notes:

## Related Issue

<!-- Link to related GitHub issue (e.g., "Fixes #123", "Closes #456") -->

## Release PR Checklist

<!-- For release PRs such as `chore(release): version x.y.z`. Remove this section if this is not a release PR. If this is a release PR, remove non-related sections from the template. -->

- [ ] Version bump is correct
- [ ] Changelog/release notes were reviewed
- [ ] Generated package or lock files are included, if applicable
- [ ] PR has the `ignore-for-release` label
- [ ] No unrelated code changes are included

## Pre-flight Checklist

- [ ] Changes match existing conventions in `extensions/`, `agents/`, `prompts/`, or `skills/` — skip if dependency-only
- [ ] Lint and type-check pass: `pnpm lint:fix && pnpm typecheck`
- [ ] No unintended changes to other files
- [ ] README or release notes updated if user-facing behavior changed
