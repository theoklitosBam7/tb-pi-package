# Agent inspector

In pi's terminal UI, use `/agent-inspector` or press `Ctrl+Shift+A`. Select a run with the arrow keys and press Enter to see its task, model, status, live response, and tool activity. Each invocation has a separate run ID, including repeated calls to the same agent.

Use Up/Down or Page Up/Page Down to scroll. Home shows the start; End follows new output. In a running run's detail view, press `x` to stop that run. The list view ignores `x`. Escape returns to the run list, then closes the inspector. Closing the view does not stop the agent.

The inspector runs in interactive TUI mode only.

The list keeps active runs and up to 50 completed runs in memory. Long output is truncated with a notice. Reloading or leaving the session clears this history; result files are unchanged. `/agents` still browses agent definitions.
