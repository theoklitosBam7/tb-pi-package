# tb-pi-package

A collection of extensions and agent definitions for [pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) — the AI coding agent.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## About

This package extends pi with custom tools, slash commands, specialized subagents, and prompt templates for code review, implementation, research, and multi-agent orchestration.

## Features

- **Subagent tool** — Delegate tasks to specialized agents with isolated context windows. Supports single, parallel, and chained (sequential) execution modes.
- **Ask user tool** — Ask one or more structured questions and collect answers in TUI or RPC mode.
- **Web search & fetch** — Search DuckDuckGo and fetch page content directly from pi.
- **Agent discovery** — Browse and inspect available agents interactively via `/agents`.
- **Commands browser** — List all registered slash commands via `/commands`.
- **Session cost report** — View main-agent, subagent, nested, and combined token and cost totals with `/session-costs`.
- **Voice dictation** — Select a Foundry Local speech model with `/dictate model`, then use `/dictate` or Control+Option+R to add speech to the editor.
- **4 built-in agents:** Scout, researcher, implementer, and reviewer, each tuned for a specific task.
- **Workflow prompts:** Reusable templates for scouting, research, implementation, review, implementation review, and wiki generation.

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

Detailed guides live in [`docs/`](docs/):

| Document                                         | Covers                                       |
| ------------------------------------------------ | -------------------------------------------- |
| [Extensions](docs/extensions.md)                 | Tools and slash commands each extension adds |
| [Subagent tool](docs/subagent-tool.md)           | Single, parallel, and chained task examples  |
| [Agent inspector](docs/agent-inspector.md)       | Inspect running and completed agent runs     |
| [Agent definitions](docs/agent-definitions.md)   | Agent files, built-in agents, AGENTS example |
| [Prompts](docs/prompts.md)                       | Workflow prompt templates                    |
| [Voice dictation](docs/voice-dictation.md)       | Foundry Local setup and `/dictate` usage     |
| [Session costs](docs/session-costs.md)           | `/session-costs` report and token accounting |
| [Subagent overrides](docs/subagent-overrides.md) | Per-agent `settings.json` overrides          |

## Project Structure

```
tb-pi-package/
├── agents/              # Agent definitions (Markdown with frontmatter)
├── docs/                # Feature guides and ADRs
├── extensions/
│   ├── ask-user/        # ask_user questionnaire tool
│   │   └── index.ts
│   ├── commands.ts      # /commands slash command
│   ├── lib/              # Shared extension helpers
│   │   └── usage.ts      # Usage parsing and aggregation
│   ├── list-agents.ts   # /agents command + list_agents tool
│   ├── session-costs/   # /session-costs slash command
│   │   └── index.ts
│   ├── voice-dictation/ # /dictate Foundry Local microphone command
│   ├── subagent/        # Agent tool (single/parallel/chain modes)
│   │   ├── agents.ts    # Agent discovery & parsing
│   │   ├── index.ts     # Subagent tool + TUI rendering
│   │   └── overrides.ts # Global per-agent override loading and validation
│   └── web-search/      # web_search & web_fetch tools
│       └── index.ts
├── prompts/             # Workflow prompt templates
├── .github/             # Issue/PR templates and release workflow
├── package.json
└── tsconfig.json
```

## Development

### Requirements

- [pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) — install separately before using this package
- [Node.js](https://nodejs.org/) >= 22.22.3
- [pnpm](https://pnpm.io/) v12.6.0

### Setup

```bash
git clone https://github.com/theoklitosBam7/tb-pi-package.git
cd tb-pi-package
pnpm install
pnpm hooks:setup
```

### Checks

```bash
pnpm fmt:check
pnpm lint:check
pnpm typecheck
pnpm typecheck:tests
pnpm test
```

## Contributing

Use the [issue templates](https://github.com/theoklitosBam7/tb-pi-package/issues/new/choose) for bugs and feature requests. Pull requests should follow [`.github/pull_request_template.md`](.github/pull_request_template.md). Run the checks above before opening a PR.

## License

MIT © [Theoklitos Bampouris](https://github.com/theoklitosBam7)
