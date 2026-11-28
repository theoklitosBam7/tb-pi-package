# tb-pi-package

Extensions, subagents, and workflow prompts for [pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent), the AI coding agent.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Quality](https://github.com/theoklitosBam7/tb-pi-package/actions/workflows/quality.yml/badge.svg)](https://github.com/theoklitosBam7/tb-pi-package/actions/workflows/quality.yml)

## Features

- **Subagent tool**: delegate work to specialized agents with isolated context windows. Single, parallel, and chained runs are synchronous by default; single and parallel runs can also start asynchronously, so the parent can message and monitor them.
- **Ask user tool**: ask one or more structured questions and collect the answers in TUI or RPC mode.
- **Web search and fetch**: search DuckDuckGo and fetch page content from pi.
- **Agent discovery**: browse and inspect the available agents with `/agents`.
- **Commands browser**: list the registered slash commands with `/commands`.
- **Session cost report**: view main-agent, subagent, nested, and combined token and cost totals with `/session-costs`.
- **Automatic recaps**: recap completed work with a separate model. `/summary` saves the global model and thinking level in `~/.pi/agent/summary.json` (defaults: `openai/gpt-6-luna`, thinking `medium`), `/summary status` shows the saved values, and `/summary reset` restores the defaults. Each recap adds provider cost.
- **Voice dictation**: choose a Foundry Local speech model with `/dictate model`, then run `/dictate` or press Control+Option+R to add speech to the editor.
- **Six built-in agents**: generalist, oracle, scout, researcher, implementer, and reviewer.
- **Workflow prompts**: templates for scouting, research, implementation, review, implementation review, and wiki generation.

## Installation

```bash
# Install globally (available in all projects)
pi install git:github.com/theoklitosBam7/tb-pi-package

# Or install per-project
pi install -l git:github.com/theoklitosBam7/tb-pi-package

# Or try without installing (current invocation only)
pi -e git:github.com/theoklitosBam7/tb-pi-package
```

`pi install` adds the package to your Pi settings. `pi -e` loads it for one invocation and caches it under `~/.pi/agent/tmp/extensions/`.

## Usage

Once installed, the package's extensions, agents, prompts, and web-search skill are available in pi.

Detailed guides live in [`docs/`](docs/):

| Document                                           | Covers                                                            |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| [Extensions](docs/extensions.md)                   | Tools and slash commands each extension adds                      |
| [SDK compatibility](docs/compatibility.md)         | Supported Pi versions and how to test another SDK                 |
| [Automatic recaps](docs/automatic-recaps.md)       | Global `/summary` settings, task scope, and limits                |
| [Web search and fetch](docs/web-search.md)         | Search, fetch, pagination, and safety limits                      |
| [Subagent tool](docs/subagent-tool.md)             | Synchronous and asynchronous tasks, messages, reports, and limits |
| [Agent inspector](docs/agent-inspector.md)         | Inspect synchronous and asynchronous agent runs                   |
| [Portable inspection](docs/portable-inspection.md) | Read-only event bus contract for compatible hosts                 |
| [Agent definitions](docs/agent-definitions.md)     | Agent files and built-in agents                                   |
| [Prompts](docs/prompts.md)                         | Workflow prompt templates                                         |
| [Voice dictation](docs/voice-dictation.md)         | Foundry Local setup and `/dictate` usage                          |
| [Session costs](docs/session-costs.md)             | `/session-costs` report and token accounting                      |
| [Subagent overrides](docs/subagent-overrides.md)   | Per-agent `settings.json` overrides                               |

## Project structure

```text
tb-pi-package/
├── agents/                # Agent definitions (Markdown with frontmatter)
├── docs/                  # Feature guides, compatibility notes, and ADRs
├── extensions/
│   ├── ask-user/          # ask_user questionnaire tool
│   ├── commands.ts        # /commands slash command
│   ├── lib/               # Helpers shared by more than one extension
│   ├── list-agents.ts     # /agents command and list_agents tool
│   ├── session-costs/     # /session-costs slash command
│   ├── subagent/          # agent tool, async runs, reports, and inspector
│   ├── summary/           # Automatic recaps and /summary configuration
│   ├── voice-dictation/   # /dictate Foundry Local microphone command
│   └── web-search/        # web_search and web_fetch tools
├── prompts/               # Workflow prompt templates
├── scripts/               # Minimum SDK version and SDK preparation helpers
├── skills/web-search/     # Web search guidance for the model
├── .github/               # Quality and compatibility workflows, templates
├── package.json
└── tsconfig.json
```

## Development

### Requirements

- [pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent), installed separately. The supported Pi SDK versions are the peer dependency range in [`package.json`](package.json), explained in [SDK compatibility](docs/compatibility.md).
- [Node.js](https://nodejs.org/) >= 22.22.3, the `engines` floor. Use the version in `.node-version` for development.
- [pnpm](https://pnpm.io/), at the version in `packageManager`. pnpm switches to it automatically.

`@types/node` stays on the 22 line, so `pnpm typecheck` rejects APIs newer than Node 22 even though development uses the version in `.node-version`.

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
pnpm test:integration
```

`pnpm test` runs the unit test suite. `pnpm test:integration` runs the tests that need a real SDK or a real process: the HTTPS transport test, the Pi SDK event bus contract tests, and the tests marked `[process integration]`. Tests that need POSIX process behavior skip on Windows.

The [Quality workflow](.github/workflows/quality.yml) runs the same checks on every pull request. The [Compatibility workflow](.github/workflows/compatibility.yml) installs the minimum Pi SDK from the peer range and runs the integration tests against it, on relevant pull requests and every week.

## Contributing

Use the [issue templates](https://github.com/theoklitosBam7/tb-pi-package/issues/new/choose) for bugs and feature requests. Pull requests should follow [`.github/pull_request_template.md`](.github/pull_request_template.md). Run the checks above before opening a PR.

## License

MIT © [Theoklitos Bampouris](https://github.com/theoklitosBam7)
