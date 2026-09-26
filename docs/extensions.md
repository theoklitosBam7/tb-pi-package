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

## web_search and web_fetch

`web_search` searches DuckDuckGo. It takes `query` and an optional `max_results` (default 8), and returns titles, URLs, and snippets.

`web_fetch` fetches a page by `url` and returns its content. HTML and XHTML pages convert to Markdown; raw files return as-is. The optional `max_length` (default 10000) caps each chunk, and `offset` paginates through long content. The conversion design is recorded in [ADR 0001](adr/0001-html-to-markdown-for-web-fetch.md).

## list_agents

`list_agents` returns the available agents with their source, tools, model, and thinking level. `/agents` shows the same list in the terminal UI, including per-agent configuration errors.

## /commands

`/commands` lists all registered slash commands grouped by source: extensions, prompts, and skills. Pass a source as an argument to filter the list, for example `/commands prompts`. Selecting an entry can show the file that provides it.
