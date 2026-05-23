# Context

## Glossary

| Term            | Definition                                                                                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`         | A named, specialized AI worker defined in a Markdown file with frontmatter (name, description, tools, model, subagent_type). Agents have isolated context windows and are invoked by name or by subagent_type. |
| `subagent_type` | A categorical label in agent frontmatter that enables type-based agent resolution as an alternative to name-based resolution (e.g., `exploration`, `planning`, `review`, `implementation`).                    |
| `chain`         | Sequential execution mode for the `agent` tool where each agent's output is passed to the next via the `{previous}` placeholder.                                                                               |
| `agent scope`   | Controls which directories are searched for agent definitions: `"user"` (~/.pi/agent/agents/), `"project"` (.pi/agents/), or `"both"`.                                                                         |
| `extension`     | A TypeScript module that registers custom tools, slash commands, or other capabilities into pi via the ExtensionAPI.                                                                                           |
| `prompt`        | A Markdown file defining a reusable multi-agent workflow pattern (e.g., `explorer-and-plan`, `implement`).                                                                                                     |
