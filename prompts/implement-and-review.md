---
description: Implement a bounded change, review it, then apply confirmed fixes
argument-hint: "<task>"
---

Use the subagent tool with the chain parameter to execute this workflow:

1. Run the `implementer` agent to implement: $@
2. Run the `reviewer` agent to review that implementation against "$@". Give it the previous report as context:

   {previous}

   Ask it to inspect the current diff, affected code paths, tests, and requirements. It must report only concrete findings with evidence and a smallest fix.

3. Run the `implementer` agent to apply confirmed findings from the review. Give it the review report as context:

   {previous}

   Include the original request, "$@", in the task. Ask it to inspect the current diff, apply only supported fixes, run relevant checks, and return a final implementation report. If the review found no issues, leave the implementation unchanged and report the verification.

Pass each step's report to the next step through `{previous}`.
