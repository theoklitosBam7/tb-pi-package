---
description: Generate comprehensive wiki documentation for a repository
argument-hint: "[repo-path] [--update page... | --all]"
---

Use the subagent tool with the chain parameter to execute this workflow.

If the user passes `--all`, regenerate every wiki page (overwrite all existing files).
If the user passes `--update Home Architecture`, only regenerate those named pages (overwrite).
If no update flags are given, only generate missing pages (skip existing).

1. First, use the "explorer" agent to thoroughly investigate the repository at "$@". Instruct the explorer to return:
   - Project structure and key directories with their purpose
   - Core modules, their responsibilities, and how they connect
   - Public API surface (exports, endpoints, CLI commands, configuration options)
   - Setup and installation requirements (dependencies, environment, build steps)
   - Entry points and startup/bootstrap flow
   - Testing and contribution conventions
   - Whether a `wiki/` directory already exists and which of these files are present: `Home.md`, `Architecture.md`, `Setup-and-Installation.md`, `API-Reference.md`, `Development-Guide.md`, `Deployment.md`

2. Then, use the "worker" agent to create the wiki documentation from the explorer's findings (use {previous} placeholder). The expected pages are:
   - `wiki/Home.md` — One-paragraph project summary, key features, and a quick-start example
   - `wiki/Architecture.md` — High-level design, component relationships, data flow, key design decisions. Use Mermaid diagrams where possible
   - `wiki/Setup-and-Installation.md` — Prerequisites, step-by-step install, configuration, verification
   - `wiki/API-Reference.md` — All public interfaces with signatures, parameters, return types, and usage examples
   - `wiki/Development-Guide.md` — Local dev setup, running tests, code style, how to contribute
   - `wiki/Deployment.md` — Build artifacts, environment variables, deploy steps, rollback

   Overwrite rules based on user arguments:
   - `--all`: regenerate and overwrite every page
   - `--update page1 page2 ...`: only regenerate and overwrite the named pages; skip the rest
   - No flags (default): only generate pages that are missing; skip existing ones

   After writing, report a summary table:

   | Page         | Status                                       |
   | ------------ | -------------------------------------------- |
   | Home         | created / updated / skipped (already exists) |
   | Architecture | ...                                          |
   | ...          | ...                                          |

   If any pages were skipped because they already exist, tell the user:
   "To update existing pages, run: `/generate-wiki --update <page-name>` or `/generate-wiki --all`"

For each page, use clear Markdown headings, fenced code blocks for examples, and keep explanations tight and actionable.

Execute this as a chain, passing output between steps via {previous}.
