# Prompts

Prompt templates in `prompts/` are Markdown files that pi turns into slash commands. The filename becomes the command name, so the templates below run as `/scout`, `/research`, `/implement`, `/implement-and-review`, `/review`, and `/generate-wiki`. Frontmatter sets a `description` and an `argument-hint`. In the body, `$@` expands to all command arguments.

| Prompt                 | Workflow                                                          |
| ---------------------- | ----------------------------------------------------------------- |
| `scout`                | Map a repository area with the scout agent                        |
| `research`             | Research an external technical question with the researcher agent |
| `implement`            | Scout the codebase, then implement with the implementer agent     |
| `implement-and-review` | Implement, review, then apply confirmed fixes                     |
| `review`               | Standalone review through the reviewer agent                      |
| `generate-wiki`        | Scout a repository, then create or update wiki pages              |

`/scout`, `/research`, and `/review` run a single agent. `/implement`, `/implement-and-review`, and `/generate-wiki` chain agents through the subagent tool and pass each report to the next step with `{previous}`.
