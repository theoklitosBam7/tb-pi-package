# Agent definitions

Agents are Markdown files with frontmatter. The `agent` tool, `list_agents`, and `/agents` read them from two locations:

- `~/.pi/agent/agents` holds user agents. They are available in every project.
- The nearest `.pi/agents` directory holds project agents. Pi walks up from the working directory to find it.

Both locations are searched recursively, including subdirectories. Only `.md` files load. Each file needs `name` and `description` in its frontmatter.

## Frontmatter

| Field           | Required | Behavior                                                      |
| --------------- | -------- | ------------------------------------------------------------- |
| `name`          | yes      | Agent name used by the `agent` tool and `/agents`.            |
| `description`   | yes      | Shown in agent listings.                                      |
| `tools`         | no       | Comma-separated tool names, for example `read, rg`.           |
| `model`         | no       | Model as `provider/id`.                                       |
| `thinking`      | no       | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `subagent_type` | no       | Type label for selection through `subagent_type`.             |

The Markdown body below the frontmatter is the agent's system prompt. An invalid `thinking` value stops that agent before it starts. `/agents` and `list_agents` show the error and still list the other agents. Settings overrides replace frontmatter values; see [Subagent overrides](subagent-overrides.md).

## Example

```md
---
name: reviewer
description: Reviews changes
tools: read, rg
thinking: high
---

Review changes for correctness and test coverage.
```

## Built-in agents

The package ships four agents in `agents/`. Each has a fixed role and a tool set:

| Agent         | Type             | Tools                                                       | Role                                                                        |
| ------------- | ---------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| `scout`       | `exploration`    | `read`, `rg`, `fd`, `ls`, `bash`                            | Maps files, execution paths, tests, constraints, and unknowns               |
| `researcher`  | `research`       | `read`, `rg`, `fd`, `ls`, `bash`, `web_search`, `web_fetch` | Answers external technical questions with traceable primary-source evidence |
| `implementer` | `implementation` | Pi defaults                                                 | Implements a bounded task and reports tests and validation                  |
| `reviewer`    | `review`         | `read`, `rg`, `fd`, `ls`, `bash`                            | Independently reviews diffs, plans, solutions, and bounded code areas       |

## Agent instructions

`.pi/AGENTS_example.md` is a starting point for `~/.pi/agent/AGENTS.md`. Copy it and adapt it to your workflow. The example is not loaded automatically because its filename is intentionally different.
