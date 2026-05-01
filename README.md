# tb-pi-package

A collection of extensions and agent definitions for [pi](https://github.com/mariozechner/pi-coding-agent) — the AI coding agent.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## About

This package extends pi with custom tools, slash commands, specialized subagents, and prompt templates for common development workflows like code review, implementation planning, and multi-agent orchestration.

## Features

- **Subagent tool** — Delegate tasks to specialized agents with isolated context windows. Supports single, parallel, and chained (sequential) execution modes.
- **Web search & fetch** — Search DuckDuckGo and fetch page content directly from pi.
- **Agent discovery** — Browse and inspect available agents interactively via `/agents`.
- **Commands browser** — List all registered slash commands via `/commands`.
- **7 built-in agents** — Scout, planner, architect, designer, reviewer, worker, and general-purpose — each tuned for a specific task.
- **Workflow prompts** — Pre-built prompt templates for scout→plan→implement, implement→review, standalone review, and wiki generation.

## Installation

```bash
# Install globally (available in all projects)
pi install git:github.com/theoklitosBam7/tb-pi-package

# Or install per-project
pi install -l git:github.com/theoklitosBam7/tb-pi-package

# Or try without installing (current session only)
pi -e git:github.com/theoklitosBam7/tb-pi-package
```

## Usage

Once installed, the package's extensions, agents, and prompts are available automatically in pi.

### Extensions

| Extension | Tool(s) | Command | Description |
|-----------|---------|---------|-------------|
| `subagent` | `agent` | — | Spawn isolated agent processes for single, parallel, or chained tasks |
| `web-search` | `web_search`, `web_fetch` | — | Search the web and fetch page content |
| `list-agents` | `list_agents` | `/agents` | Discover and browse agent definitions |
| `commands` | — | `/commands` | List all registered slash commands |

### Agents

Agents are defined as Markdown files with frontmatter in `agents/`. Each agent has a specialized role, tool set, and model:

| Agent | Type | Role |
|-------|------|------|
| `scout` | `reconnaissance` | Fast codebase recon, returns compressed context for handoff |
| `planner` | `planning` | Creates implementation plans from context and requirements |
| `architect` | `analysis` | Analyzes structure, coupling, and architectural boundaries |
| `designer` | `analysis` | Proposes interface designs under specific constraints |
| `reviewer` | `review` | Code review for quality, security, and maintainability |
| `worker` | `implementation` | General-purpose agent with full file system capabilities |
| `general-purpose` | `general` | Read-only analysis, research, documentation, and explanation |

### Prompts

Workflow prompts in `prompts/` provide ready-made multi-agent patterns:

| Prompt | Workflow |
|--------|----------|
| `scout-and-plan` | Scout gathers context → Planner creates plan |
| `implement` | Scout → Planner → Worker implements |
| `implement-and-review` | Worker implements → Reviewer reviews → Worker applies feedback |
| `review` | Standalone code review via the reviewer agent |
| `generate-wiki` | Scout investigates repo → Worker generates and writes wiki pages to `wiki/` |

### Subagent Tool Examples

```
# Single task
agent({ agent: "scout", task: "Explore the auth module and summarize its structure" })

# Parallel tasks
agent({ tasks: [
  { agent: "scout", task: "Explore the API layer" },
  { agent: "scout", task: "Explore the database layer" }
]})

# Chained workflow (output of step N feeds into step N+1 via {previous})
agent({ chain: [
  { agent: "scout", task: "Investigate the caching module" },
  { agent: "planner", task: "Create an implementation plan for adding TTL support based on: {previous}" },
  { agent: "worker", task: "Implement the plan from: {previous}" }
]})
```

## Project Structure

```
tb-pi-package/
├── agents/              # Agent definitions (Markdown with frontmatter)
├── extensions/
│   ├── commands.ts      # /commands slash command
│   ├── list-agents.ts   # /agents command + list_agents tool
│   ├── subagent/        # Agent tool (single/parallel/chain modes)
│   │   ├── agents.ts    # Agent discovery & parsing
│   │   └── index.ts     # Subagent tool + TUI rendering
│   └── web-search/      # web_search & web_fetch tools
│       └── index.ts
├── prompts/             # Workflow prompt templates
├── package.json
└── tsconfig.json
```

## Development

### Requirements

- [Node.js](https://nodejs.org/) >= 22.12.0
- [Bun](https://bun.sh/)

### Setup

```bash
git clone https://github.com/theoklitosBam7/tb-pi-package.git
cd tb-pi-package
bun install
```

### Type Checking

```bash
bun run typecheck
```

## License

MIT © [Theoklitos Bampouris](https://github.com/theoklitosBam7)
