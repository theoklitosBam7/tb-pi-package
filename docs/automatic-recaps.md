# Automatic recaps

The summary extension automatically recaps the latest task after Pi finishes its work, including any retries or automatic continuation. `/summary` only configures the model and thinking level. It does not generate a recap.

## Configuration

Run `/summary`, select a model, then select one of its supported thinking levels. Completing both selections saves them globally. Cancelling either selection leaves the saved settings unchanged. The command supports terminal and RPC dialogs.

The extension reads `summary.json` in Pi's agent directory, normally `~/.pi/agent/summary.json`. `PI_CODING_AGENT_DIR` changes that directory. There are no project overrides. If the file is absent, the defaults are:

```json
{
  "provider": "openai",
  "model": "gpt-6-luna",
  "thinking": "medium"
}
```

The file must contain these three fields and no others. Provider and model must be nonempty strings without surrounding whitespace. Thinking must be `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`, and the selected model must support it. The model picker lists models available through Pi's configured providers. Recaps use Pi's existing credentials, not separate credentials. An unavailable model, unsupported thinking level, invalid configuration, or failed request produces an error notification. There is no silent model fallback. Fix an invalid file manually before saving new selections.

## Completion and task scope

A recap starts after Pi emits its final `agent_settled` event, not after each turn or tool call. It requires a consumed user request and a final assistant response with stop reason `stop`. Aborted or failed tasks, incomplete responses, and requests with no assistant response do not trigger a recap. Queued requests use the latest consumed user request as the task boundary.

The recap contains changes, checks, and unfinished work from that task only. It uses user and assistant text, tool calls, and tool-result text. It respects context edits, excludes older tasks and compaction summaries, and omits hidden thinking and image payloads. It does not read additional files or execute tools. Text in the task record is sent to the selected summary provider.

The request runs in the background. A new agent run, a new consumed user request, session shutdown, or tree navigation cancels an outstanding recap. Late results are discarded. Saved settings are read for each recap; changing settings does not change a request already sent. The main agent's model and thinking level remain unchanged.

## Output, limits, and costs

Successful recaps are stored as custom `summary` session entries. The extension registers a custom-entry renderer, so Pi displays them in the terminal transcript. They do not enter model context or start another agent run. Configuration dialogs also work in RPC mode, but the recap display uses Pi's custom-entry renderer rather than an RPC notification or assistant message.

Recaps make additional, potentially billable model requests. Each saved recap entry includes its model, thinking level, and returned usage. Pi 1.3.0 does not expose a native usage-entry append API to extensions, so these requests are not included in Pi's native session totals or `/session-costs`. Failed or cancelled requests can also incur provider charges, and their usage is not saved by this extension.

The input is limited to 48,000 characters. Longer task records retain their beginning and end with a truncation marker, so some work can be omitted. This is a character limit, not an exact token budget. Requests have a 60-second timeout, no automatic retries, and an output limit of the lesser of 8,192 tokens or the model's maximum. Context-limit errors, truncated responses, and empty responses are reported rather than displayed as successful recaps. There is no automatic retry after a recap failure.
