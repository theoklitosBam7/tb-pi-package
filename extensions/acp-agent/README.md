# ACP agent bridge (experimental)

This extension delegates a single task to an ACP **v1** agent over local JSON-RPC stdio.

## Set up

Create `~/.pi/agent/acp-agents.json` with permissions `0600`.
Commands **must be absolute paths**. Use the executable that starts your
ACP-capable agent in stdio mode, with its required arguments. For example:

```json
{
  "my-agent": {
    "command": "/absolute/path/to/acp-agent",
    "args": [],
    "startupTimeoutMs": 30000,
    "timeoutMs": 600000,
    "inactivityTimeoutMs": 120000
  }
}
```

Run `chmod 600 ~/.pi/agent/acp-agents.json` and restart Pi.
The extension registers the `acp_agent` tool and `/acp` command.

The package loads `./extensions` automatically.

## Security model

- User-level configuration only; no model-supplied executable or shell.
- Absolute executable paths, no shell invocation.
- Rejects symlinked, group-readable or world-readable configuration files.
- Rejects agent-initiated client methods, including permissions, filesystem and terminal.
- Bounded task length (100k characters), JSON frame (1 MiB), output (256 KiB),
  startup (30 s), total runtime (10 min by default, configurable up to 60 min),
  inactivity (2 min by default), and concurrent runs (2).
- Cancellation kills the child process; errors do not expose stderr.
- Child processes inherit the current working directory and environment.
  **This is not a sandbox.** Only configure agents you trust. Do not run with secrets
  in the environment that those agents should not access.
- No session pooling in this version. A fresh process is used for each task
  to avoid cross-task state. The concurrency limit protects resources.

## Limitations

ACP v1 only. Client filesystem, terminal and permission requests are not supported.
The task output includes only `agent_message_chunk` text. Session persistence,
rich tool events, MCP server injection, and ACP v2 are not supported.

## Timeouts

All settings are optional, per-agent, in milliseconds. Allowed values are
1 through 3,600,000 ms (60 minutes). Defaults:

| Setting | Default | Behavior |
| --- | --- | --- |
| `startupTimeoutMs` | 30,000 | Initialize response must arrive before this deadline |
| `timeoutMs` | 600,000 | Absolute deadline from process launch |
| `inactivityTimeoutMs` | 120,000 | Valid ACP messages reset this deadline |

The overall deadline cannot be reset by agent output. Long tasks can run if
they continue sending protocol messages, but they still stop at `timeoutMs`.
A slow but quiet agent may hit `inactivityTimeoutMs` first. Cancellation
remains available at all times.
