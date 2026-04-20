---
description: Reviewer analyzes current changes for correctness, scope, simplicity, maintainability, safety, and tests
---
Use the subagent tool to run the "reviewer" agent on: $@

Ask the reviewer to:
- focus on correctness, scope, simplicity, maintainability, safety, and test coverage
- prioritize findings by severity
- be concrete and tightly scoped to the actual changes
- call out assumptions or unclear intent instead of guessing
- suggest the smallest reasonable fix for each issue

Return:
- Summary
- Findings sorted by severity
- Open questions
- Approval status
