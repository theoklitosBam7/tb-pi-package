# Agent inspector

In pi's terminal UI, use `/agent-inspector` or press `Ctrl+Shift+A`. Select a run with the arrow keys and press Enter to see its task, model, status, live response, and tool activity. Each invocation has a separate run ID, including repeated calls to the same agent. A watchdog timeout has the distinct `timed out` status; a manual stop has the `aborted` status. For an abort after the child starts, the detail view reports that cleanup is unknown. Read the result artifact for the deadline or cleanup status.

The detail view separates requested and attempted model selections from observed dispatch and provider-reported response IDs. Unknown values mean the child did not supply that evidence. An observed dispatch does not prove that a response was generated. See [Subagent tool](subagent-tool.md#model-provenance) for the evidence limits.

Use Up/Down or Page Up/Page Down to scroll. Home shows the start; End follows new output. In a running run's detail view, press `x` to stop that run. The list view ignores `x`. Escape returns to the run list, then closes the inspector. Closing the view does not stop the agent.

The inspector runs in interactive TUI mode only. It replaces the input area below the transcript while open. This keeps image previews out of the inspector's text. Closing it restores the input area.

The inspector shows asynchronous runs managed by the current session. The list keeps active runs and up to 50 completed runs in memory. Long output is truncated with a notice. Reloading or leaving the session clears this history; result files are unchanged. `/agents` still browses agent definitions.

For asynchronous runs, use `agent_status` to see queued work, reports, message outcomes, and terminal results. Use `agent_send` to send a steering or follow-up message, and `agent_cancel` to stop a run. The parent also receives explicit reports and terminal notifications as the runs progress. A notification can trigger a parent turn while other runs continue.

Run state and child processes do not recover after reload or a parent crash. The final artifacts remain on disk. On session shutdown, the extension cancels queued and active runs through the bounded cleanup path.
