---
description: Scout the codebase, then implement a bounded change
argument-hint: "<task>"
---

Use the subagent tool with the chain parameter to execute this workflow:

1. Run the `scout` agent to investigate the code relevant to: $@. Ask it to return the relevant files and symbols, execution path, tests, constraints, and unknowns. The scout must keep the repository unchanged.
2. Run the `implementer` agent to implement "$@" using the scout report below:

   {previous}

   Ask the implementer to inspect the current files before editing, make the smallest coherent change, add or update focused tests for behavior changes, run relevant checks, and report any unresolved design decision.

Pass each step's report to the next step through `{previous}`. Return the implementer's final report.
