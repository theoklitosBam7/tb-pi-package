# Subagent tool

The `agent` tool runs tasks in one of three modes: single, parallel, or chained. Each task runs in a child agent process with its own context window and returns a Markdown artifact path. Read that file before you continue work that depends on the result.

| Mode     | Input            | Behavior                                        |
| -------- | ---------------- | ----------------------------------------------- |
| Single   | `agent` + `task` | One agent runs one task                         |
| Parallel | `tasks`          | Tasks run concurrently                          |
| Chain    | `chain`          | Steps run in order, `{previous}` carries output |

## Parameters

| Parameter              | Type    | Behavior                                                                                                                                            |
| ---------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`                | string  | Name of the agent to invoke. Mutually exclusive with `subagent_type`.                                                                               |
| `subagent_type`        | string  | Select an agent by type, for example `planning` or `review`.                                                                                        |
| `task`                 | string  | Task text for single mode.                                                                                                                          |
| `model`                | string  | Model as `provider/id`, or `inherit` for the parent model. Overrides settings and frontmatter.                                                      |
| `thinking`             | string  | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `inherit` for the parent level. Overrides settings and frontmatter.                   |
| `tasks`                | array   | Parallel mode. Each item accepts `agent`, `subagent_type`, `task`, `cwd`, `model`, and `thinking`. Item values take priority over top-level values. |
| `chain`                | array   | Sequential mode. Same item fields as `tasks`.                                                                                                       |
| `agentScope`           | string  | `user`, `project`, or `both`. Default `user`.                                                                                                       |
| `confirmProjectAgents` | boolean | Prompt before project-local agents run. Default `true`.                                                                                             |
| `cwd`                  | string  | Working directory for single mode.                                                                                                                  |

In a chain, step N+1 receives step N's report wherever its task contains `{previous}`.

## Model priority

The tool resolves each agent's model in this order: the tool input `model`, the settings override, the agent frontmatter, then the parent agent's model. For thinking, the order is tool input, settings override, frontmatter, then the parent level. Set both `model` and `thinking` to `inherit` to use the parent's current values even when settings or frontmatter specify different values. Settings overrides are described in [Subagent overrides](subagent-overrides.md).

## Agent scope

By default the tool sees agents from `~/.pi/agent/agents`. Set `agentScope` to `both` or `project` to include agents from the nearest `.pi/agents` directory. With `both`, a project agent replaces a user agent with the same name. The tool asks for confirmation before it runs project-local agents; set `confirmProjectAgents` to `false` to skip the prompt.

## Examples

```
# Single task
agent({ agent: "scout", task: "Map the auth module and summarize its structure", model: "inherit", thinking: "inherit" })

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
