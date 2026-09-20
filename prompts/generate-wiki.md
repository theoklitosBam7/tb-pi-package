---
description: Create or update concise wiki pages from repository evidence
argument-hint: "[repo-path] [--update <page> ... | --all]"
---

Use the subagent tool with the chain parameter to execute this workflow.

Treat the arguments as follows:

- `--all` regenerates every wiki page and overwrites existing files.
- `--update <page> ...` regenerates only the named pages and overwrites them.
- Without an update flag, create only missing pages and preserve existing files.

1. Run the `scout` agent to investigate the repository described by "$@". Ask it to return:
   - Project structure and key directories
   - Core modules, responsibilities, and connections
   - Public interfaces, commands, and configuration
   - Setup, dependencies, and verification steps
   - Entry points and startup flow
   - Testing and contribution conventions
   - Existing wiki pages and their current status
2. Run the `implementer` agent to create or update the selected wiki pages from the scout report below:

   {previous}

   The standard pages are:
   - `wiki/Home.md`: Project summary, key features, and a quick-start example
   - `wiki/Architecture.md`: Design, component relationships, data flow, and key decisions
   - `wiki/Setup-and-Installation.md`: Prerequisites, installation, configuration, and verification
   - `wiki/API-Reference.md`: Public interfaces, parameters, return types, and examples
   - `wiki/Development-Guide.md`: Local development, tests, style, and contribution steps
   - `wiki/Deployment.md`: Build artifacts, environment, deployment, and rollback

   Keep each page concise, factual, and based on repository evidence. Use fenced code blocks for commands and examples. Return a status table with `created`, `updated`, or `skipped` for every page.

Pass the scout report to the implementer through `{previous}`. Return the implementer's final report.
