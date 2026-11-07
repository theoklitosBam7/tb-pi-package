# Subagent tool

By default, the `agent` tool runs tasks synchronously in single, parallel, or chained mode. It waits for the requested work to finish and returns a Markdown artifact path for each task. Set `async: true` for a single or parallel run to return run IDs promptly and manage the work while it continues.

| Mode     | Input            | Behavior                                        |
| -------- | ---------------- | ----------------------------------------------- |
| Single   | `agent` + `task` | One agent runs one task                         |
| Parallel | `tasks`          | Tasks run concurrently                          |
| Chain    | `chain`          | Steps run in order, `{previous}` carries output |

## Parameters

| Parameter              | Type    | Behavior                                                                                                                                                                                      |
| ---------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `async`                | boolean | Start single or parallel tasks asynchronously. Async chains are not supported.                                                                                                                |
| `agent`                | string  | Name of the agent to invoke. Mutually exclusive with `subagent_type`.                                                                                                                         |
| `subagent_type`        | string  | Select an agent by type, for example `planning` or `review`.                                                                                                                                  |
| `task`                 | string  | Task text for single mode.                                                                                                                                                                    |
| `model`                | string  | Model as `provider/id`, or `inherit` for the parent model. Overrides settings and frontmatter.                                                                                                |
| `modelFallback`        | string  | `configured` (default) permits model retries; `none` prevents extension-managed fallback. Items can override the top-level value.                                                             |
| `thinking`             | string  | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `inherit` for the parent level. Overrides settings and frontmatter.                                                             |
| `watchdog`             | object  | Optional deadlines in seconds: `idleSeconds` (default 300), `toolSeconds` (default 600), and `taskSeconds` (default 1800). Set an individual limit to `null` to disable it.                   |
| `tasks`                | array   | Parallel mode. Each item accepts `agent`, `subagent_type`, `task`, `cwd`, `model`, `modelFallback`, `thinking`, and `watchdog`. Item watchdog fields override only matching top-level fields. |
| `chain`                | array   | Sequential mode. Same item fields as `tasks`.                                                                                                                                                 |
| `agentScope`           | string  | `user`, `project`, or `both`. Default `user`.                                                                                                                                                 |
| `confirmProjectAgents` | boolean | Prompt before project-local agents run. Default `true`.                                                                                                                                       |
| `cwd`                  | string  | Working directory for single mode.                                                                                                                                                            |

In a chain, step N+1 receives step N's report wherever its task contains `{previous}`.

## Asynchronous runs

Set `async: true` for a single task or a `tasks` array to start asynchronous runs. The tool validates the full request, schedules the runs, and returns run IDs and initial status snapshots. It does not wait for the children to finish. Async chains are not supported. Managed children also cannot launch asynchronous subagents; they can still use the synchronous modes.

The asynchronous session manager runs up to four children at once and queues up to 32 more. These limits apply to asynchronous runs; synchronous calls keep their existing limits. The manager rejects a batch that exceeds the queue limit before starting any task in that batch. A queued task's watchdog starts when the task starts.

For example, start a run, check its state, and send it a follow-up message:

```js
agent({ async: true, agent: "scout", task: "Map the authentication flow" });
agent_status({ runId: "<run ID from the first result>" });
agent_send({
  runId: "<run ID from the first result>",
  message: "Include the token refresh path",
  mode: "follow_up",
});
```

Use `agent_status` with no arguments to list this session's asynchronous runs, or pass `runId` to inspect one run. A snapshot includes its ID, agent, task, state, reports, and message delivery outcomes. States are `queued`, `running`, `stopping`, `completed`, `failed`, `aborted`, and `timed-out`. The `completed` state reports child execution. Review the artifact against the task to assess the work. A terminal result includes its artifact path when one exists. The manager retains up to 50 terminal runs in memory.

Use `agent_send` with `runId`, `message`, and `mode: "steer"` or `mode: "follow_up"` to send a message to a queued or active run. The tool returns an accepted message ID, or a rejection reason. Acceptance means the manager queued the message. Check `agent_status` for its delivery outcome. `accepted-by-child` confirms transport acceptance only. It does not prove that the child model read or followed the message. A message accepted before the child exits may become `undelivered`. Each run accepts at most 32 messages, each up to 8,000 UTF-16 code units.

The child can call `report_to_parent` with a `message` field to send an explicit progress report. The call returns when the parent manager accepts or rejects the report. It does not wait for a reply. The parent receives report notifications while the child runs. While the parent run is active, Pi makes each report and terminal notification available at a safe agent-loop boundary. This does not interrupt an active model request or tool call. An event can start a turn when the parent is idle. Terminal notifications include run details and the artifact path when the artifact was written first. A run can send at most 32 reports, each up to 8,000 UTF-16 code units and 8 KiB of UTF-8 data. `agent_status` retains accepted reports within the manager's retention limits. It confirms stored state, not that the parent model read or acted on a report. Ordinary child output remains available in the inspector.

Use `agent_cancel` with a `runId` to stop an asynchronous run. Queued tasks are cancelled before they start. Active tasks use the same bounded process cleanup as an inspector stop. Parent abort after the asynchronous launch returns does not cancel the run. Pi shuts down the current session before a session change or reload; the extension then cancels queued and active runs and clears their in-memory state. A parent crash does not restore process or message state. Final artifacts remain on disk, but the manager does not reattach to child processes.

When an artifact is available, the run writes it before sending its terminal notification. A queued cancellation or finalization failure may have no artifact. Terminal states do not restart. To continue work after completion, start a new run. The extension sends asynchronous reports and results as custom messages for session history. Notifications are best-effort; use `agent_status` to check a run if a notification does not arrive.

## Child output limits

The runner discards a stdout JSONL line longer than 1,048,576 UTF-16 code units, then resumes at the next line. It retains at most 65,536 UTF-16 code units of stderr. The result's stderr includes `[stdout line truncated]` or `[stderr truncated]` when either limit is exceeded. Watchdog timeout results omit stderr, including these markers, to avoid exposing child diagnostics.

## Watchdog limits

The watchdog observes child-process events. It does not poll the model. Nonempty assistant text and reasoning deltas count as progress, as do tool starts, matched tool ends, distinct tool updates, and completed messages. Defaults are 300 seconds without progress (including startup), 600 seconds for one tool call, and 1800 seconds for a complete child run, including model fallback attempts. Values must be positive integer seconds up to 2,147,483; `null` disables that deadline. Top-level values set the single-run limits and the defaults for parallel and chain items. Item values override only their own fields. The tool does not infer a watchdog limit from a child tool's arguments.

A watchdog timeout is separate from a child error or a manual stop. It prevents fallback retries and produces a failed result with a timeout summary and artifact. The artifact records the deadline, limit, elapsed time, recent progress age, and cleanup status. On POSIX systems the runner starts the child in a dedicated process group. It signals that group on timeout, parent abort, or inspector stop only while the direct child is still running. If the direct child has exited, the runner does not signal the group because it cannot prove the group identity. It escalates to SIGKILL after five seconds if the direct child is still known to be running, then waits at most one more second for `close`. On other platforms it signals only the direct child. Cleanup is reported as unknown for timeouts because the runner cannot verify that every descendant has exited. For a parent abort or inspector stop after a child starts, the result records cleanup as unknown. The summary and artifact report this uncertainty. An abort before a child starts does not report cleanup status. Older results may have no cleanup record. A timeout does not undo partial file changes or external effects. Inspect the artifact, worktree, and any surviving processes before continuing; do not assume that the task failed without making changes.

In parallel mode, only the timed-out child is stopped. The synchronous call still waits for its other children to finish or reach their own deadlines. A queued task's timers start when its child process starts, not while it waits for a concurrency slot.

## Model priority

The tool resolves each agent's model in this order: the tool input `model`, the settings override, the agent frontmatter, then the parent agent's model. For thinking, the order is tool input, settings override, frontmatter, then the parent level. Set both `model` and `thinking` to `inherit` to use the parent's current values even when settings or frontmatter specify different values. The inspector and artifact show the resolved thinking launch setting. `Thinking: child default (no explicit level passed)` means the runner passed no `--thinking` value. It describes the launch setting, not a measured runtime reasoning budget. A queued run can show the resolved launch setting before execution starts. Settings overrides are described in [Subagent overrides](subagent-overrides.md).

For parallel and chain calls, `modelFallback: "none"` requires a concrete model selection. The runner checks every strict item before it starts any child. A top-level policy applies to each item unless the item specifies its own policy. An explicit strict `model: "inherit"` requires the parent model to be available.

## Model provenance

Result artifacts and the inspector separate the requested selection, resolved candidates, attempted launch selections, observed Pi dispatch identities, and provider response model IDs. `child default` means the runner passed no model argument. An empty dispatch observation appears as `Observed dispatch: not observed`. An empty response ID appears as `Provider response model ID: not supplied by Pi`. Multiple identities remain listed separately. A dispatch identity can come from an error event and does not prove that a model generated a response. Pi supplies response model IDs when it has them. A response ID on an error does not prove that a model generated output.

The legacy `Model` field records the last launch selection when one was supplied. Older results may have only that field. Pi can resolve model names or providers differently. Provider routing or virtual models can hide the physical model, so these records do not prove an exact physical model.

## Agent scope

By default the tool sees agents from `~/.pi/agent/agents`. Set `agentScope` to `both` or `project` to include agents from the nearest `.pi/agents` directory. With `both`, a project agent replaces a user agent with the same name. The tool asks for confirmation before it runs project-local agents; set `confirmProjectAgents` to `false` to skip the prompt.

## Examples

```
# Single task; override a default deadline for a known long operation
agent({ agent: "scout", task: "Map the auth module and summarize its structure", watchdog: { idleSeconds: 900, toolSeconds: null }, model: "inherit", thinking: "inherit" })

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
