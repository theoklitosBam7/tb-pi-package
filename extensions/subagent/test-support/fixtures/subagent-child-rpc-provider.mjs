import * as fs from "node:fs";
import * as path from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { waitForMarker } from "./subagent-rpc-marker.mjs";

const fixtureDirectory = process.env.SUBAGENT_CHILD_RPC_DIR;
if (!fixtureDirectory) throw new Error("SUBAGENT_CHILD_RPC_DIR is required.");

const marker = (name) => path.join(fixtureDirectory, name);

function userText(messages) {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => {
      if (typeof message.content === "string") return message.content;
      if (!Array.isArray(message.content)) return "";
      return message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(" ");
    })
    .join("\n");
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

function waitForAbort(signal) {
  return new Promise((resolve) => {
    if (!signal || signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", resolve, { once: true });
  });
}

export default function registerFixtureProvider(pi) {
  pi.registerProvider("local-fixture", {
    api: "openai-completions",
    baseUrl: "http://127.0.0.1/unused",
    apiKey: "unused",
    models: [
      {
        id: "fixture-model",
        name: "Fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 256,
      },
    ],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const prompt = userText(context.messages);

        if (prompt.includes("abort-checkpoint")) {
          fs.writeFileSync(marker("abort-call"), "started");
          await waitForAbort(options?.signal);
          finish(stream, model, [], "aborted");
          return;
        }

        let waitMarker;
        let releaseMarker;
        if (prompt.includes("follow-up payload")) {
          waitMarker = "follow-up-call";
          releaseMarker = "release-follow-up";
        } else if (prompt.includes("steering payload")) {
          waitMarker = "steer-call";
          releaseMarker = "release-steer";
        } else {
          waitMarker = "first-call";
          releaseMarker = "release-first";
        }

        fs.writeFileSync(marker(waitMarker), prompt);
        const released = await waitForMarker(marker(releaseMarker), { signal: options?.signal });
        if (!released || options?.signal?.aborted) {
          stream.end();
          return;
        }

        finish(stream, model, [{ type: "text", text: "local fixture complete" }], "stop");
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
