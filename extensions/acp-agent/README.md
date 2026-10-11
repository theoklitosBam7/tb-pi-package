# ACP agent bridge (experimental)

This extension delegates a single task to Codex over local ACP v1 JSON-RPC stdio.
The accepted adapter is [`@agentclientprotocol/codex-acp`](https://github.com/agentclientprotocol/codex-acp).

## Set up

Install the Codex ACP adapter and record its version and executable path:

```bash
npm install -g @agentclientprotocol/codex-acp
codex-acp --version
command -v codex-acp
```

The adapter includes a compatible Codex dependency. The `codex` CLI executable
is not the ACP adapter. Authenticate before using the bridge; the bridge does
not implement ACP authentication requests.

Create `~/.pi/agent/acp-agents.json` with permissions `0600`.
Commands must be absolute paths. Replace the adapter path below with the output
of `command -v codex-acp`:

```json
{
  "codex": {
    "command": "/usr/bin/env",
    "args": ["INITIAL_AGENT_MODE=read-only", "/absolute/path/to/codex-acp"],
    "startupTimeoutMs": 30000,
    "timeoutMs": 600000,
    "inactivityTimeoutMs": 120000
  }
}
```

`/usr/bin/env` sets the adapter's initial mode to read-only without a shell.
It still passes Pi's environment to the adapter. This setting is not a sandbox
provided by the bridge.

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
- Idle sessions close after 60 seconds; sessions close on Pi shutdown, task failure, or cancellation. Sessions are reused for sequential tasks to the same agent and workspace.
  Each session accepts one task at a time. A maximum of two sessions can exist.

## Limitations

ACP v1 only. Client filesystem, terminal and permission requests are not supported.
A reused session preserves agent state between tasks. Use separate workspaces
or restart Pi when isolation is required. The task output includes only
`agent_message_chunk` text. Rich tool events, MCP server injection, and ACP v2
are not supported. Sessions are reused only within the current Pi process;
restoring an ACP session after Pi restarts is not supported.

## Timeouts

All settings are optional, per-agent, in milliseconds. Allowed values are
1 through 3,600,000 ms (60 minutes). Defaults:

| Setting               | Default | Behavior                                                          |
| --------------------- | ------- | ----------------------------------------------------------------- |
| `startupTimeoutMs`    | 30,000  | Initialize response must arrive before this deadline              |
| `timeoutMs`           | 600,000 | Deadline for each task, including agent startup on its first task |
| `inactivityTimeoutMs` | 120,000 | Valid ACP messages reset this deadline                            |

Each task starts a new overall deadline, even when the ACP process is reused.
The task deadline cannot be reset by agent output. JSON-RPC responses must
contain exactly one of `result` or `error`. Invalid messages fail the task and
close the session instead of extending inactivity. Long tasks can run if
they continue sending protocol messages, but they still stop at `timeoutMs`.
A slow but quiet agent may hit `inactivityTimeoutMs` first. Cancellation
remains available at all times.

The 1 MiB frame limit applies to each newline-delimited JSON message, excluding
the newline, and to any incomplete frame. Multiple messages in one stdout write
do not share a frame-size limit.

## Persistent sessions

The extension now reuses one ACP process and session for sequential tasks to the
same agent, executable configuration, working directory, and timeout settings.
Different workspaces use different sessions. Two sessions are allowed in total.\nWhen both slots contain idle sessions, the oldest available idle session is closed\nto make room for a new agent or workspace.
Concurrent tasks for one session are rejected rather than interleaved.
Idle sessions are closed after 60 seconds. An error, cancellation, or Pi shutdown
closes the related direct child process. Descendant processes are not guaranteed\nto stop. This avoids repeated startup cost, but means the
agent can retain prior task context and has access to the same workspace.

## Codex verification

Codex is the accepted adapter for this experimental bridge. Manual smoke tests
confirmed initialization, prompt delivery, and retained context across sequential
prompts. These results do not establish compatibility with every adapter version
or verify cancellation and process cleanup.

Before merge, record the exact Codex ACP adapter executable and version. Complete
manual checks for cancellation, task deadlines, process cleanup, and refusal of
client filesystem, terminal, and permission requests.
