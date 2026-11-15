## Summary

<!-- 2-3 sentences: what this does and why. Add one small visual when it helps:
     diff sketch, call tree, file tree, or sequence. Skip for trivial changes. -->

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

## Evidence

<!-- Before and after. Test output, tool output, screenshots, or agent behavior.
     Skip the pair only for dependency-only PRs. -->

**Before:**

**After:**

## Verification

- [ ] `pnpm fmt:check`, `pnpm lint:check`, `pnpm typecheck`, `pnpm typecheck:tests`, `pnpm test`
- [ ] `pnpm test:integration` when the change touches a process or RPC boundary
- [ ] Tested in pi (install method: global / local / session) — skip if dependency-only
- Manual notes:

## Merge Danger

**Door:** two-way | one-way — why

**Blast Radius:** one word

<!-- Optional: what a merge can affect. -->

## Related Issue

<!-- Fixes #123, Closes #456, or "None: <reason>" -->

## Pre-flight Checklist

- [ ] Changes match existing conventions in `extensions/`, `agents/`, `prompts/`, or `skills/` — skip if dependency-only
- [ ] No unintended changes to other files
- [ ] README or release notes updated if user-facing behavior changed

## Release PR Checklist

<!-- For release PRs such as `chore(release): version x.y.z`. Remove this section if this is not a release PR. -->

- [ ] Version bump is correct
- [ ] Changelog/release notes were reviewed
- [ ] Generated package or lock files are included, if applicable
- [ ] PR has the `ignore-for-release` label
- [ ] No unrelated code changes are included
