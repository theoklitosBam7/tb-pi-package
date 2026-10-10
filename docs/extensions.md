# Extensions

Each extension below ships with this package and loads automatically in pi.

| Extension         | Tool(s)                   | Command            | Description                                                              |
| ----------------- | ------------------------- | ------------------ | ------------------------------------------------------------------------ |
| `subagent`        | `agent`                   | `/agent-inspector` | Spawn and inspect isolated agents for single, parallel, or chained tasks |
| `ask-user`        | `ask_user`                | —                  | Ask structured questions in TUI or RPC mode                              |
| `web-search`      | `web_search`, `web_fetch` | —                  | Search the web and fetch page content                                    |
| `list-agents`     | `list_agents`             | `/agents`          | Discover and browse agent definitions                                    |
| `commands`        | —                         | `/commands`        | List all registered slash commands                                       |
| `session-costs`   | —                         | `/session-costs`   | Show main-agent and subagent token and cost usage                        |
| `voice-dictation` | —                         | `/dictate`         | Dictate with a local speech model and add text to the editor             |

## ask_user

`ask_user` asks one or more structured questions and waits for answers. Each question takes:

| Field      | Required | Behavior                                                              |
| ---------- | -------- | --------------------------------------------------------------------- |
| `id`       | yes      | Unique identifier for the answer.                                     |
| `question` | yes      | Question text.                                                        |
| `header`   | no       | Short label for the question.                                         |
| `options`  | no       | Selectable options. Each has a `label` and an optional `description`. |
| `is_other` | no       | Adds a free-text option.                                              |

In TUI mode, each question replaces the input area below the transcript while open. The panel header shows the current question number and total, such as `1/8` or `2/8`. A single question shows `1/1`. The counter stays the same when you enter or leave a custom answer. Image previews remain in the transcript and cannot cover question text. Answering or cancelling restores the input area. RPC mode continues to use the client's dialogs.

## web_search and web_fetch

`web_search` finds DuckDuckGo results; `web_fetch` reads public pages as text or Markdown. See [Web search and fetch](web-search.md) for examples, limits, pagination, and source-trust guidance.

## list_agents

`list_agents` returns the available agents with their source, tools, model, and thinking level. `/agents` shows the same list in the terminal UI, including per-agent configuration errors.

## /commands

`/commands` lists all registered slash commands grouped by source: extensions, prompts, and skills. Pass a source as an argument to filter the list, for example `/commands prompts`. Selecting an entry can show the file that provides it.
