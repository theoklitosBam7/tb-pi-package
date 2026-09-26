# Subagent overrides

Set persistent overrides by agent name in Pi's global `settings.json`. Pi normally stores this file at `~/.pi/agent/settings.json`. If you configure a different agent directory, the extension reads `settings.json` from that directory instead.

```json
{
  "subagents": {
    "agentOverrides": {
      "researcher": {
        "model": "openai-codex/gpt-6-luna",
        "thinking": "medium",
        "systemPrompt": "Use primary sources and report unknowns."
      },
      "reviewer": {
        "model": "another-provider/model-1",
        "thinking": "xhigh",
        "tools": ["read", "rg"]
      }
    }
  }
}
```

Each override supports these fields:

| Field          | Type     | Behavior                                                                                            |
| -------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `model`        | string   | Adds a model choice after the tool input and before agent frontmatter in the fallback order.        |
| `thinking`     | string   | Accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.                               |
| `tools`        | string[] | Replaces frontmatter tools. Use a non-empty list of names without commas or surrounding whitespace. |
| `systemPrompt` | string   | Replaces the agent's Markdown body. An empty string removes the agent-specific prompt.              |

The model order is tool input, settings override, agent frontmatter, then the parent model. Settings `thinking` overrides frontmatter. If neither is set, Pi uses its default. Settings `tools` replaces frontmatter tools. If neither is set, Pi uses its default tools. The extension tries the next model after a model or API-key failure. Pi limits the configured thinking level to what the selected model supports.

`systemPrompt` replaces only the agent-specific prompt. The child process still receives Pi's standard system prompt, context files, tool guidance, and skills.

The extension reads one settings snapshot at the start of each `agent` or `list_agents` call. File changes apply on the next call without `/reload`. Overrides match the resolved agent's exact name, including agents selected through `subagent_type`. Unknown agent names are ignored.

Invalid per-agent settings or an invalid frontmatter `thinking` value stop the affected agent before it starts. `/agents` and `list_agents` show per-agent errors while listing other agents. A malformed `settings.json` prevents the listing. The commands report whether a settings prompt override is active, but do not print the prompt text.
