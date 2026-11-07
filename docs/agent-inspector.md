# Agent inspector

In pi's terminal UI, use `/agent-inspector` or press `Ctrl+Shift+A`. Select a run with the arrow keys and press Enter to see its task, model, status, live response, and tool activity. Each invocation has a separate run ID, including repeated calls to the same agent. A watchdog timeout has the distinct `timed out` status; a manual stop has the `aborted` status. For an abort after the child starts, the detail view reports that cleanup is unknown. Read the result artifact for the deadline or cleanup status.

The detail view separates requested and attempted model selections from observed dispatch and provider response model IDs. An empty dispatch observation appears as `Observed dispatch: not observed`. An empty response ID appears as `Provider response model ID: not supplied by Pi`. A dispatch identity does not prove that a response was generated. Pi may not expose the physical model behind a provider route. See [Subagent tool](subagent-tool.md#model-provenance) for the evidence limits.

`Thinking` shows the level resolved for the child launch. A queued run can show this level before the child starts. `child default (no explicit level passed)` means the runner did not pass a `--thinking` value. It does not report an observed runtime reasoning budget.

Use Up/Down or Page Up/Page Down to scroll. Home shows the start; End follows new output. In a running run's detail view, press `x` to stop that run. The list view ignores `x`. Escape returns to the run list, then closes the inspector. Closing the view does not stop the agent.

The inspector runs in interactive TUI mode only. It replaces the input area below the transcript while open. This keeps image previews out of the inspector's text. Closing it restores the input area.

Compatible hosts can subscribe to [portable inspection](portable-inspection.md) for a bounded, read-only view of agent activity. That contract does not provide child controls or artifact access. It does not change the terminal inspector or the subagent tool and result contracts.

The inspector shows asynchronous runs managed by the current session. The list keeps active runs and up to 50 completed runs in memory. Long output is truncated with a notice. Reloading or leaving the session clears this history; result files are unchanged. `/agents` still browses agent definitions.

For asynchronous runs, use `agent_status` to see queued work, reports, message outcomes, and terminal results. Use `agent_send` to send a steering or follow-up message, and `agent_cancel` to stop a run. The parent receives explicit reports and terminal notifications as the runs progress. While a parent run is active, Pi makes each notification available at a safe agent-loop boundary. This does not interrupt an active model request or tool call. An event can start a turn when the parent is idle. The status record confirms stored events; it does not confirm that the parent model read or acted on them. A `completed` status reports child execution. Review the artifact against the task to assess the work.

Run state and child processes do not recover after reload or a parent crash. The final artifacts remain on disk. On session shutdown, the extension cancels queued and active runs through the bounded cleanup path.
