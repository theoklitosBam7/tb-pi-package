import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTemporaryProject,
  repositoryRoot,
  startPiRpc,
  waitForFile,
} from "../test-support/pi-rpc-process.js";

const providerFixturePath = path.join(
  repositoryRoot,
  "extensions",
  "subagent",
  "test-support",
  "fixtures",
  "subagent-child-rpc-provider.mjs",
);
const temporaryDirectories: string[] = [];

function createProject(): string {
  const project = createTemporaryProject("subagent-child-rpc-");
  temporaryDirectories.push(project);
  return project;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Pi 1.5 child RPC contract", () => {
  it("[process integration] queues steer and follow-up messages and reports abort settlement", async () => {
    const project = createProject();
    const marker = (name: string) => path.join(project, name);
    const rpc = startPiRpc({
      projectDirectory: project,
      agentDirectory: project,
      model: "local-fixture/fixture-model",
      extensions: [providerFixturePath],
      environment: { SUBAGENT_CHILD_RPC_DIR: project },
    });

    try {
      rpc.send({ id: "prompt", type: "prompt", message: "begin controlled checkpoint" });
      const promptResponse = await rpc.waitFor(
        (record) => record.type === "response" && record.id === "prompt",
      );
      expect(promptResponse).toMatchObject({
        success: true,
        data: { disposition: "started" },
      });
      await waitForFile(marker("first-call"));

      rpc.send({ id: "steer", type: "steer", message: "steering payload green-marker" });
      const steerResponse = await rpc.waitFor(
        (record) => record.type === "response" && record.id === "steer",
      );
      expect(steerResponse).toMatchObject({ success: true, data: { disposition: "queued" } });
      fs.writeFileSync(marker("release-first"), "release");

      await waitForFile(marker("steer-call"));
      expect(fs.readFileSync(marker("steer-call"), "utf8")).toContain(
        "steering payload green-marker",
      );

      rpc.send({
        id: "follow-up",
        type: "follow_up",
        message: "follow-up payload blue-marker",
      });
      const followUpResponse = await rpc.waitFor(
        (record) => record.type === "response" && record.id === "follow-up",
      );
      expect(followUpResponse).toMatchObject({
        success: true,
        data: { disposition: "queued" },
      });
      fs.writeFileSync(marker("release-steer"), "release");

      await waitForFile(marker("follow-up-call"));
      expect(fs.readFileSync(marker("follow-up-call"), "utf8")).toContain(
        "follow-up payload blue-marker",
      );
      fs.writeFileSync(marker("release-follow-up"), "release");

      const completedRun = await rpc.waitFor(
        (record) => record.type === "agent_settled" && record.aborted === false,
      );
      expect(completedRun.aborted).toBe(false);

      rpc.send({ id: "abort-prompt", type: "prompt", message: "abort-checkpoint" });
      const abortPrompt = await rpc.waitFor(
        (record) => record.type === "response" && record.id === "abort-prompt",
      );
      expect(abortPrompt).toMatchObject({ success: true, data: { disposition: "started" } });
      await waitForFile(marker("abort-call"));

      rpc.send({ id: "abort", type: "abort" });
      const abortedRun = await rpc.waitFor(
        (record) => record.type === "agent_settled" && record.aborted === true,
      );
      const abortResponse = await rpc.waitFor(
        (record) => record.type === "response" && record.id === "abort",
      );
      expect(abortedRun.aborted).toBe(true);
      expect(abortResponse.success).toBe(true);
    } finally {
      await rpc.close();
    }
  }, 45_000);
});
