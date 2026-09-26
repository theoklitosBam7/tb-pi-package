# Session costs

Run `/session-costs` to see token and cost totals for the current session. The report includes main-agent usage, direct subagent usage, nested subagent usage, and combined totals.

The report uses Pi's billed-token rules. Prompt tokens are `input + cacheRead + cacheWrite`. Total tokens add `output`, and cost uses each recorded `cost.total` value. It scans all session entries, so its main totals match Pi's `/session` accounting. Pi's `/session` does not recurse into subagent details, and this command does not change `/session`.

Older subagent records may not contain nested usage. `/session-costs` reports a warning when it cannot recover that usage instead of treating it as zero.
