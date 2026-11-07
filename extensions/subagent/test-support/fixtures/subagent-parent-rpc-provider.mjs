import * as fs from "node:fs";
import * as path from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { waitForMarker } from "./subagent-rpc-marker.mjs";

const fixtureDirectory = process.env.SUBAGENT_PARENT_RPC_DIR;
if (!fixtureDirectory) throw new Error("SUBAGENT_PARENT_RPC_DIR is required.");

const isChild = process.env.SUBAGENT_MANAGED_CHILD === "1";
const eventPath = path.join(
  fixtureDirectory,
  isChild ? "child-events.jsonl" : "parent-events.jsonl",
);
const marker = (name) => path.join(fixtureDirectory, name);
const reportMarkers = ["rpc-report-one", "rpc-report-two", "rpc-report-three"];
const finalReplyMarker = "parent-saw-all-subagent-notifications";

function record(event) {
  fs.appendFileSync(eventPath, `${JSON.stringify(event)}\n`);
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join(" ");
}

function summarizeContextMessages(messages) {
  return messages.map((message) => ({
    role: message.role,
    content: contentText(message.content),
  }));
}

function assistantMessage(model, content, stopReason) {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function finish(stream, model, content, stopReason) {
  const message = assistantMessage(model, content, stopReason);
  stream.push({
    type: "start",
    partial: { ...message, content: [], stopReason: "pending" },
  });
  stream.push({ type: "done", reason: stopReason, message });
  stream.end();
}

async function runChildTurn(stream, model, turn, options) {
  const report = reportMarkers[turn - 1];
  if (report) {
    record({ kind: "child_waiting_for_report", report });
    const released = await waitForMarker(marker(`release-${report}`), {
      signal: options?.signal,
    });
    if (!released || options?.signal?.aborted) {
      stream.end();
      return;
    }
    finish(
      stream,
      model,
      [
        {
          type: "toolCall",
          id: `report-${turn}`,
          name: "report_to_parent",
          arguments: { message: report },
        },
      ],
      "toolUse",
    );
    return;
  }

  if (turn === 4) {
    record({ kind: "child_waiting_for_finish" });
    const released = await waitForMarker(marker("release-child-finish"), {
      signal: options?.signal,
    });
    if (!released || options?.signal?.aborted) {
      stream.end();
      return;
    }
    record({ kind: "child_finished" });
    fs.writeFileSync(marker("child-finished"), "finished");
    finish(stream, model, [{ type: "text", text: "fixture-child-complete" }], "stop");
    return;
  }

  throw new Error(`Unexpected child model turn ${turn}.`);
}

export default function registerFixtureProvider(pi) {
  let parentTurns = 0;
  let parentToolCalls = 0;
  let childTurns = 0;
  let activeParentTurns = 0;

  pi.registerTool({
    name: "parent_work",
    label: "Parent work",
    description: "Hold the parent turn while the child reports progress.",
    parameters: Type.Object({}),
    async execute() {
      parentToolCalls += 1;
      record({ kind: "parent_tool_started", call: parentToolCalls });
      await waitForMarker(marker(`release-parent-tool-${parentToolCalls}`));
      return { content: [{ type: "text", text: "fixture-parent-work-complete" }] };
    },
  });

  pi.registerProvider("fixture", {
    api: "openai-completions",
    baseUrl: "http://127.0.0.1/unused",
    apiKey: "fixture",
    models: [
      {
        id: "fixture-model",
        name: "Fixture Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 512,
      },
    ],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        if (isChild) {
          childTurns += 1;
          await runChildTurn(stream, model, childTurns, options);
          return;
        }

        parentTurns += 1;
        activeParentTurns += 1;
        if (activeParentTurns > 1) record({ kind: "overlapping_parent_model_turns" });
        const contextMessages = summarizeContextMessages(context.messages);
        const visibleReports = reportMarkers.filter((report) =>
          contextMessages.some(
            (message) =>
              message.role === "user" &&
              message.content.startsWith("Subagent ") &&
              message.content.includes(" report ") &&
              message.content.includes(report),
          ),
        );
        const terminalVisible = contextMessages.some(
          (message) =>
            message.role === "user" &&
            message.content.startsWith("Subagent ") &&
            message.content.includes(" completed ("),
        );
        const childFinished = fs.existsSync(marker("child-finished"));
        record({ kind: "parent_model_call", visibleReports, childFinished, terminalVisible });

        try {
          if (parentTurns === 1) {
            finish(
              stream,
              model,
              [
                {
                  type: "toolCall",
                  id: "launch-child",
                  name: "agent",
                  arguments: {
                    async: true,
                    agent: "worker",
                    task: "Send three reports, then finish.",
                    agentScope: "project",
                    confirmProjectAgents: false,
                    model: "fixture/fixture-model",
                  },
                },
              ],
              "toolUse",
            );
            return;
          }

          if (parentTurns === 2) {
            finish(stream, model, [{ type: "text", text: "fixture-parent-idle" }], "stop");
            return;
          }

          if (parentTurns === 3) {
            finish(
              stream,
              model,
              [{ type: "toolCall", id: "hold-parent", name: "parent_work", arguments: {} }],
              "toolUse",
            );
            return;
          }

          if (parentTurns === 4) {
            finish(
              stream,
              model,
              [{ type: "toolCall", id: "hold-parent-again", name: "parent_work", arguments: {} }],
              "toolUse",
            );
            return;
          }

          if (parentTurns === 5) {
            finish(
              stream,
              model,
              [{ type: "toolCall", id: "check-child-status", name: "agent_status", arguments: {} }],
              "toolUse",
            );
            return;
          }

          const hasEveryReport = visibleReports.length === reportMarkers.length;
          const reply =
            hasEveryReport && childFinished && terminalVisible
              ? finalReplyMarker
              : "parent-waiting-for-subagent-notifications";
          finish(stream, model, [{ type: "text", text: reply }], "stop");
        } finally {
          activeParentTurns -= 1;
        }
      })().catch((error) => {
        const failed = assistantMessage(model, [], "error");
        failed.errorMessage = String(error);
        stream.push({ type: "error", reason: "error", error: failed });
        stream.end();
      });
      return stream;
    },
  });
}
