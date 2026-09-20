# tb-pi-package

A collection of extensions and agent definitions for [pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) — the AI coding agent.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## About

This package extends pi with custom tools, slash commands, specialized subagents, and prompt templates for code review, implementation, research, and multi-agent orchestration.

## Features

- **Subagent tool** — Delegate tasks to specialized agents with isolated context windows. Supports single, parallel, and chained (sequential) execution modes.
- **Web search & fetch** — Search DuckDuckGo and fetch page content directly from pi.
- **Agent discovery** — Browse and inspect available agents interactively via `/agents`.
- **Commands browser** — List all registered slash commands via `/commands`.
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

### Extensions

| Extension     | Tool(s)                   | Command            | Description                                                              |
| ------------- | ------------------------- | ------------------ | ------------------------------------------------------------------------ |
| `subagent`    | `agent`                   | `/agent-inspector` | Spawn and inspect isolated agents for single, parallel, or chained tasks |
| `web-search`  | `web_search`, `web_fetch` | —                  | Search the web and fetch page content                                    |
| `list-agents` | `list_agents`             | `/agents`          | Discover and browse agent definitions                                    |
| `commands`    | —                         | `/commands`        | List all registered slash commands                                       |

### Agents

Agents are defined as Markdown files with frontmatter in `agents/`. Each agent has a specialized role, tool set, and model:

| Agent         | Type             | Role                                                                        |
| ------------- | ---------------- | --------------------------------------------------------------------------- |
| `scout`       | `exploration`    | Maps files, execution paths, tests, constraints, and unknowns               |
| `researcher`  | `research`       | Answers external technical questions with traceable primary-source evidence |
| `implementer` | `implementation` | Implements a bounded task and reports tests and validation                  |
| `reviewer`    | `review`         | Independently reviews diffs, plans, solutions, and bounded code areas       |

### Prompts

Prompt templates in `prompts/` provide ready-made single-agent and chained workflows:

| Prompt                 | Workflow                                                          |
| ---------------------- | ----------------------------------------------------------------- |
| `scout`                | Map a repository area with the scout agent                        |
| `research`             | Research an external technical question with the researcher agent |
| `implement`            | Scout the codebase, then implement with the implementer agent     |
| `implement-and-review` | Implement, review, then apply confirmed fixes                     |
| `review`               | Standalone review through the reviewer agent                      |
| `generate-wiki`        | Scout a repository, then create or update wiki pages              |

### Subagent Tool Examples

```
# Single task
agent({ agent: "scout", task: "Map the auth module and summarize its structure" })

# Parallel tasks
agent({ tasks: [
  { agent: "scout", task: "Map the API layer" },
  { agent: "scout", task: "Map the database layer" }
]})

# Chained workflow (output of step N feeds into step N+1 via {previous})
agent({ chain: [
  { agent: "scout", task: "Investigate the caching module" },
  { agent: "implementer", task: "Implement TTL support using this context: {previous}" }
]})
```

### Inspect running agents

In pi's terminal UI, use `/agent-inspector` or press `Ctrl+Shift+A`. Select a run with the arrow keys and press Enter to see its task, model, status, live response, and tool activity. Each invocation has a separate run ID, including repeated calls to the same agent.

Use Up/Down or Page Up/Page Down to scroll. Home shows the start; End follows new output. Escape returns to the run list, then closes the inspector. Closing the view does not stop the agent. The inspector is read-only.

The list keeps active runs and up to 50 completed runs in memory. Long output is truncated with a notice. Reloading or leaving the session clears this history; result files are unchanged. `/agents` still browses agent definitions.

### Agent instructions

`.pi/AGENTS_example.md` is a starting point for `~/.pi/agent/AGENTS.md`. Copy it and adapt it to your workflow. The example is not loaded automatically because its filename is intentionally different.

### Subagent overrides

Set persistent overrides by agent name in Pi's global `settings.json`. Pi normally stores this file at `~/.pi/agent/settings.json`. If you configure a different agent directory, the extension reads `settings.json` from that directory instead.

```json
{
  "subagents": {
    "agentOverrides": {
      "researcher": {
        "model": "openai-codex/gpt-5.6-luna",
        "thinking": "medium",
        "systemPrompt": "Use primary sources and report unknowns."
      },
      "reviewer": {
        "model": "another-provider/model-1",
        "thinking": "xhigh"
      }
    }
  }
}
```

Each override supports these fields:

| Field          | Type   | Behavior                                                                                     |
| -------------- | ------ | -------------------------------------------------------------------------------------------- |
| `model`        | string | Adds a model choice after the tool input and before agent frontmatter in the fallback order. |
| `thinking`     | string | Accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.                        |
| `systemPrompt` | string | Replaces the agent's Markdown body. An empty string removes the agent-specific prompt.       |

The model order is tool input, settings override, agent frontmatter, then the parent model. Model and API-key failures continue to the next choice. The configured thinking level applies to every attempt, and Pi clamps it to the selected model's capabilities.

`systemPrompt` replaces only the agent-specific prompt. The child process still receives Pi's standard system prompt, context files, tool guidance, and skills.

The extension reads one settings snapshot at the start of each `agent` or `list_agents` call. File changes apply on the next call without `/reload`. Overrides match the resolved agent's exact name, including agents selected through `subagent_type`. Unknown agent names are ignored.

Invalid settings fail before the affected agent starts. `list_agents` marks invalid discovered-agent overrides but continues to list other agents. It reports whether a settings prompt override is active without printing the prompt text.

## Project Structure

```
tb-pi-package/
├── agents/              # Agent definitions (Markdown with frontmatter)
├── extensions/
│   ├── commands.ts      # /commands slash command
│   ├── list-agents.ts   # /agents command + list_agents tool
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
- [pnpm](https://pnpm.io/) v11

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
