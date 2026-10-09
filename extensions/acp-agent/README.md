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
    "args": []
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
  runtime (120 s), and concurrent runs (2).
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
