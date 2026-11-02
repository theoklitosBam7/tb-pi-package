---
name: prepare-release
description: Prepare a release branch, version bump, and pull request for this project. Use when asked to prepare a release.
disable-model-invocation: false
---

# Prepare a release

1. Get the release version from the user's request. If it is missing, stop and ask the user for it. Do not infer a version from the current package version or Git history. Accept an optional `v` prefix and use the version without it in `package.json`.
2. Inspect the working tree and current branch. Preserve existing work. If uncommitted changes would interfere with the release, stop and ask the user how to proceed. Fetch the latest `main`, then create `release/v<version>` from the updated `origin/main`. If the branch already exists, stop and ask the user how to proceed.
3. Update the version in `package.json`. Check whether generated package or lock files also need changes, and include them only if applicable. Review the changes since the previous release and the release notes using `.github/RELEASE_TEMPLATE.md` and `.github/release.yml`.
4. Run the checks in `.github/workflows/quality.yml`. Inspect the diff and confirm that it contains the intended release changes and no unrelated work. If a check fails or cannot run, report it and stop before committing.
5. Commit the release changes with `chore(release): version <version>`. Push the release branch and open a pull request against `main`. Follow the release section of `.github/pull_request_template.md`, include the check results, and apply the `ignore-for-release` label. If a push, PR, or label operation fails, report what remains to be done.
6. Report the PR URL, version, and check results. Leave merging, tagging, and publishing for a separate request.
