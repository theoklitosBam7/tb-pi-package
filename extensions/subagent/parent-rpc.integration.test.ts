import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTemporaryProject,
  isJsonRecord,
  readJsonLines,
  repositoryRoot,
  startPiRpc,
  waitForCondition,
} from "./test-support/pi-rpc-process.js";

const providerFixturePath = path.join(
  repositoryRoot,
  "extensions",
  "subagent",
  "test-support",
  "fixtures",
  "subagent-parent-rpc-provider.mjs",
);
const subagentExtensionPath = path.join(repositoryRoot, "extensions", "subagent", "index.ts");
const reportMarkers = ["rpc-report-one", "rpc-report-two", "rpc-report-three"];
const finalReplyMarker = "parent-saw-all-subagent-notifications";
const temporaryDirectories: string[] = [];

function getProviderEvents(projectDirectory: string, processName: "child" | "parent") {
  return readJsonLines(path.join(projectDirectory, processName + "-events.jsonl"));
}

function getParentModelCalls(projectDirectory: string): Record<string, unknown>[] {
  return getProviderEvents(projectDirectory, "parent").filter(
    (event) => event.kind === "parent_model_call",
  );
}

function getVisibleReports(parentCall: Record<string, unknown>): string[] {
  if (!Array.isArray(parentCall.visibleReports)) return [];
  return parentCall.visibleReports.filter((report): report is string => typeof report === "string");
}

function getSubagentNotifications(rpc: ReturnType<typeof startPiRpc>): Record<string, unknown>[] {
  return rpc.records.flatMap((record) => {
    if (record.type !== "message_end" || !isJsonRecord(record.message)) return [];
    const message = record.message;
    if (
      message.role !== "custom" ||
      (message.customType !== "subagent-report" && message.customType !== "subagent-result")
    ) {
      return [];
    }
    return [message];
  });
}

function isSubagentNotification(
  record: Record<string, unknown>,
  customType: "subagent-report" | "subagent-result",
  contentMarker?: string,
): boolean {
  if (record.type !== "message_end" || !isJsonRecord(record.message)) return false;
  const message = record.message;
  return (
    message.role === "custom" &&
    message.customType === customType &&
    (contentMarker === undefined ||
      (typeof message.content === "string" && message.content.includes(contentMarker)))
  );
}

function isFinalParentReply(record: Record<string, unknown>): boolean {
  if (record.type !== "message_end" || !isJsonRecord(record.message)) return false;
  const message = record.message;
  return (
    message.role === "assistant" &&
    Array.isArray(message.content) &&
    message.content.some(
      (part) =>
        isJsonRecord(part) &&
        part.type === "text" &&
        typeof part.text === "string" &&
        part.text.includes(finalReplyMarker),
    )
  );
}

async function waitForSubagentNotification(
  rpc: ReturnType<typeof startPiRpc>,
  projectDirectory: string,
  customType: "subagent-report" | "subagent-result",
  contentMarker?: string,
): Promise<Record<string, unknown>> {
  try {
    return await rpc.waitFor((record) => isSubagentNotification(record, customType, contentMarker));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}\nChild fixture events: ${JSON.stringify(getProviderEvents(projectDirectory, "child"))}` +
        `\nParent fixture events: ${JSON.stringify(getProviderEvents(projectDirectory, "parent"))}`,
    );
  }
}

function createFixture(): { project: string; agentDirectory: string } {
  const project = createTemporaryProject("subagent-parent-rpc-");
  temporaryDirectories.push(project);
  const agentDirectory = path.join(project, "agent-dir");
  fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
  fs.mkdirSync(agentDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(project, ".pi", "agents", "worker.md"),
    "---\nname: worker\ndescription: Deterministic RPC fixture worker\nmodel: fixture/fixture-model\n---\n",
  );
  fs.writeFileSync(
    path.join(agentDirectory, "settings.json"),
    JSON.stringify({ extensions: [providerFixturePath] }),
  );
  return { project, agentDirectory };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Pi 1.5 parent and child RPC contract", () => {
  it("[process integration] delivers child notifications before parent settlement without stale turns", async () => {
    const { project, agentDirectory } = createFixture();
    const marker = (name: string) => path.join(project, name);
    const rpc = startPiRpc({
      projectDirectory: project,
      agentDirectory,
      model: "fixture/fixture-model",
      extensions: [subagentExtensionPath],
      environment: { SUBAGENT_PARENT_RPC_DIR: project },
    });

    try {
      rpc.send({
        id: "parent-prompt",
        type: "prompt",
        message: "Start the worker and wait for its reports.",
      });
      const promptResponse = await rpc.waitFor(
        (record) => record.type === "response" && record.id === "parent-prompt",
      );
      expect(promptResponse).toMatchObject({ success: true, data: { disposition: "started" } });
      await rpc.waitFor((record) => record.type === "agent_settled");
      await waitForCondition(
        () =>
          getProviderEvents(project, "child").some(
            (event) =>
              event.kind === "child_waiting_for_report" && event.report === reportMarkers[0],
          ),
        "the child to request its first report release",
      );

      fs.writeFileSync(marker("release-" + reportMarkers[0]), "release");
      await waitForSubagentNotification(rpc, project, "subagent-report", reportMarkers[0]);
      await waitForCondition(
        () =>
          getProviderEvents(project, "parent").some(
            (event) => event.kind === "parent_tool_started",
          ),
        "the parent tool to start",
      );
      const parentCallsBeforeChildFinishes = getParentModelCalls(project).length;

      await waitForCondition(
        () =>
          getProviderEvents(project, "child").some(
            (event) =>
              event.kind === "child_waiting_for_report" && event.report === reportMarkers[1],
          ),
        "the child to request its second report release",
      );
      fs.writeFileSync(marker("release-" + reportMarkers[1]), "release");
      await waitForCondition(
        () =>
          getProviderEvents(project, "child").some(
            (event) =>
              event.kind === "child_waiting_for_report" && event.report === reportMarkers[2],
          ),
        "the child to request its third report release",
      );
      fs.writeFileSync(marker("release-" + reportMarkers[2]), "release");
      await waitForCondition(
        () =>
          getProviderEvents(project, "child").some(
            (event) => event.kind === "child_waiting_for_finish",
          ),
        "the child to finish its reports",
      );

      const parentEventsWhileToolIsActive = getProviderEvents(project, "parent");
      expect(getParentModelCalls(project)).toHaveLength(parentCallsBeforeChildFinishes);
      expect(getSubagentNotifications(rpc).map((notification) => notification.customType)).toEqual([
        "subagent-report",
      ]);
      expect(
        parentEventsWhileToolIsActive.some(
          (event) => event.kind === "overlapping_parent_model_turns",
        ),
      ).toBe(false);

      fs.writeFileSync(marker("release-parent-tool-1"), "release");
      try {
        await waitForCondition(
          () =>
            getParentModelCalls(project).some((call) =>
              getVisibleReports(call).includes(reportMarkers[1]),
            ),
          "the parent model to receive the second child report after its first tool call",
          5_000,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `${message}\nParent fixture events: ${JSON.stringify(getProviderEvents(project, "parent"))}`,
        );
      }
      const resumedParentCall = getParentModelCalls(project).find((call) =>
        getVisibleReports(call).includes(reportMarkers[1]),
      );
      if (!resumedParentCall)
        throw new Error("The parent did not receive the second child report.");
      expect(getVisibleReports(resumedParentCall)).toContain(reportMarkers[1]);
      await waitForCondition(
        () =>
          getProviderEvents(project, "parent").some(
            (event) => event.kind === "parent_tool_started" && event.call === 2,
          ),
        "the parent to continue its active task with a second tool call",
        5_000,
      );
      const parentEventsAfterReport = getProviderEvents(project, "parent");
      const resumedCallIndex = parentEventsAfterReport.findIndex(
        (event) =>
          event.kind === "parent_model_call" && getVisibleReports(event).includes(reportMarkers[1]),
      );
      const secondToolStartIndex = parentEventsAfterReport.findIndex(
        (event) => event.kind === "parent_tool_started" && event.call === 2,
      );
      expect(resumedCallIndex).toBeGreaterThanOrEqual(0);
      expect(secondToolStartIndex).toBeGreaterThan(resumedCallIndex);
      expect(rpc.records.some(isFinalParentReply)).toBe(false);

      const parentModelCallsWhileSecondToolIsActive = getParentModelCalls(project).length;
      fs.writeFileSync(marker("release-child-finish"), "release");
      await waitForCondition(
        () => getProviderEvents(project, "child").some((event) => event.kind === "child_finished"),
        "the child model to finish",
      );
      expect(getParentModelCalls(project)).toHaveLength(parentModelCallsWhileSecondToolIsActive);
      expect(rpc.records.some(isFinalParentReply)).toBe(false);

      fs.writeFileSync(marker("release-parent-tool-2"), "release");

      const finalReplyRecord = await rpc.waitFor(isFinalParentReply, 25_000);
      const finalReplyIndex = rpc.records.indexOf(finalReplyRecord);
      await waitForSubagentNotification(rpc, project, "subagent-report", reportMarkers[1]);
      await waitForSubagentNotification(rpc, project, "subagent-report", reportMarkers[2]);
      const terminalNotification = await waitForSubagentNotification(
        rpc,
        project,
        "subagent-result",
      );
      const terminalNotificationIndex = rpc.records.indexOf(terminalNotification);
      expect(terminalNotificationIndex).toBeLessThan(finalReplyIndex);
      await rpc.waitFor(
        (record) =>
          record.type === "agent_settled" &&
          rpc.records.indexOf(record) > Math.max(finalReplyIndex, terminalNotificationIndex),
        25_000,
      );

      const notifications = getSubagentNotifications(rpc);
      const reports = notifications.filter(
        (notification) => notification.customType === "subagent-report",
      );
      const terminalResults = notifications.filter(
        (notification) => notification.customType === "subagent-result",
      );
      const reportIndices = rpc.records.flatMap((record, index) =>
        isSubagentNotification(record, "subagent-report") ? [index] : [],
      );
      expect(reportIndices).toHaveLength(reports.length);
      expect(reportIndices.every((index) => index < finalReplyIndex)).toBe(true);
      const receivedMarkers = reports.map((report) =>
        reportMarkers.find(
          (markerText) => typeof report.content === "string" && report.content.includes(markerText),
        ),
      );

      expect(receivedMarkers).toEqual(reportMarkers);
      expect(notifications.map((notification) => notification.customType)).toEqual([
        "subagent-report",
        "subagent-report",
        "subagent-report",
        "subagent-result",
      ]);
      expect(terminalResults).toHaveLength(1);
      const reportDetails = reports.map((report) =>
        isJsonRecord(report.details) ? report.details : {},
      );
      const runIds = reportDetails.map((details) => details.runId);
      const eventIds = reportDetails.map((details) => details.eventId);
      expect(runIds.every((runId) => typeof runId === "string")).toBe(true);
      expect(new Set(runIds).size).toBe(1);
      expect(eventIds.every((eventId) => typeof eventId === "string")).toBe(true);
      expect(new Set(eventIds).size).toBe(reportMarkers.length);
      const terminalDetails = isJsonRecord(terminalResults[0].details)
        ? terminalResults[0].details
        : {};
      expect(terminalDetails.runId).toBe(runIds[0]);

      const finalParentCall = [...getParentModelCalls(project)]
        .reverse()
        .find((call) => call.childFinished === true);
      if (!finalParentCall) throw new Error("The parent did not resume after the child finished.");
      expect(getVisibleReports(finalParentCall)).toEqual(reportMarkers);
      expect(finalParentCall.terminalVisible).toBe(true);

      const parentModelCallsAtSettlement = getParentModelCalls(project);
      const parentModelCallCountAtSettlement = parentModelCallsAtSettlement.length;
      const finalReplyCountAtSettlement = rpc.records.filter(isFinalParentReply).length;
      // Child model completion can precede artifact writing and terminal notification delivery.
      // Waiting calls before delivery are valid; another terminal-aware call is not.
      expect(parentModelCallsAtSettlement.filter((call) => call.terminalVisible === true)).toEqual([
        finalParentCall,
      ]);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(finalReplyCountAtSettlement).toBe(1);
      expect(getParentModelCalls(project)).toHaveLength(parentModelCallCountAtSettlement);
      expect(rpc.records.filter(isFinalParentReply)).toHaveLength(finalReplyCountAtSettlement);
    } finally {
      await rpc.close();
    }
  }, 60_000);
});
