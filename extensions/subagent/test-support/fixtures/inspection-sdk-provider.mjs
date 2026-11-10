import * as fs from "node:fs";
import * as path from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const directory = process.env.INSPECTION_FIXTURE_DIR;
if (!directory) throw new Error("INSPECTION_FIXTURE_DIR is required");
const child = process.env.SUBAGENT_MANAGED_CHILD === "1";
const marker = (name) => path.join(directory, name);

async function wait(name, signal) {
  while (!fs.existsSync(marker(name))) {
    if (signal?.aborted) throw new Error("fixture aborted");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function message(model, content, stopReason) {
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

export default function inspectionFixture(pi) {
  let turn = 0;
  pi.registerTool({
    name: "inspection_fixture_tool",
    label: "Inspection fixture tool",
    description: "A deterministic child tool.",
    parameters: Type.Object({}),
    async execute() {
      fs.writeFileSync(marker("child-pid"), String(process.pid));
      fs.writeFileSync(marker("tool-started"), "ready");
      await wait("release-tool");
      return { content: [{ type: "text", text: "inspection-tool-output" }] };
    },
  });
  pi.registerProvider("fixture", {
    api: "openai-completions",
    baseUrl: "http://127.0.0.1/unused",
    apiKey: "fixture",
    models: [
      {
        id: "fixture-model",
        name: "Fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 512,
      },
    ],
    streamSimple(model, _context, options) {
      const stream = createAssistantMessageEventStream();
      turn += 1;
      void (async () => {
        let content;
        let reason;
        if (!child && turn === 1) {
          content = [
            {
              type: "toolCall",
              id: "inspection-launch",
              name: "agent",
              arguments: {
                async: true,
                agent: "worker",
                task: "Run inspection fixture",
                agentScope: "project",
                confirmProjectAgents: false,
                model: "fixture/fixture-model",
              },
            },
          ];
          reason = "toolUse";
        } else if (child && turn === 1) {
          await wait("release-child", options?.signal);
          content = [
            { type: "text", text: "inspection-live-text" },
            {
              type: "toolCall",
              id: "inspection-tool",
              name: "inspection_fixture_tool",
              arguments: {},
            },
          ];
          reason = "toolUse";
        } else {
          content = [
            {
              type: "text",
              text: child ? "inspection-child-finished" : "inspection-parent-finished",
            },
          ];
          reason = "stop";
        }
        const result = message(model, content, reason);
        stream.push({ type: "start", partial: { ...result, content: [], stopReason: "pending" } });
        if (child && turn === 1) {
          stream.push({
            type: "text_start",
            contentIndex: 0,
            partial: { ...result, content: [{ type: "text", text: "" }] },
          });
          stream.push({
            type: "text_delta",
            contentIndex: 0,
            delta: "inspection-live-text",
            partial: result,
          });
          stream.push({
            type: "text_end",
            contentIndex: 0,
            content: "inspection-live-text",
            partial: result,
          });
        }
        stream.push({ type: "done", reason, message: result });
        stream.end();
      })().catch((error) => {
        const result = message(model, [], "error");
        result.errorMessage = String(error);
        stream.push({ type: "error", reason: "error", error: result });
        stream.end();
      });
      return stream;
    },
  });
}
