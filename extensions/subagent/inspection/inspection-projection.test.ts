import { expect, it } from "vitest";
import { AgentInspectorStore } from "./inspector.js";
import { projectInspection } from "./inspection-projection.js";

it("projects immutable visible activity without private tool arguments", () => {
  const store = new AgentInspectorStore();
  const run = store.start({ agent: "scout", task: "inspect" });
  run.appendText("hello");
  run.toolStart("tool-1", "read", { secret: "private" });
  const projection = projectInspection(store.snapshot());
  expect(projection.activities[0]).toMatchObject({
    title: "scout",
    task: "inspect",
    state: "running",
    items: [
      { kind: "response", text: "hello" },
      { kind: "tool", name: "read", output: "" },
    ],
  });
  expect(JSON.stringify(projection)).not.toContain("private");
  run.appendText(" later");
  expect(projection.activities[0].items[0]).toMatchObject({ text: "hello" });
});

it("reports source truncation for task, title, response, and tool output", () => {
  const store = new AgentInspectorStore();
  store.start({ agent: "a".repeat(257), task: "task" });
  store.start({ agent: "scout", task: "t".repeat(4001) });
  const responseRun = store.start({ agent: "scout", task: "task" });
  responseRun.appendText("r".repeat(16001));
  const toolRun = store.start({ agent: "scout", task: "task" });
  toolRun.toolStart("tool", "read", { secret: "private" });
  toolRun.toolUpdate("tool", "o".repeat(8001));

  const [tool, response, task, title] = projectInspection(store.snapshot()).activities;
  expect(title.truncated).toBe(true);
  expect(task.truncated).toBe(true);
  expect(response).toMatchObject({
    truncated: true,
    items: [{ kind: "response", truncated: true }],
  });
  expect(tool).toMatchObject({ truncated: true, items: [{ kind: "tool", truncated: true }] });
  expect(JSON.stringify(tool)).not.toContain("private");
});

it("retains recent resolved model selections", () => {
  const store = new AgentInspectorStore();
  const run = store.start({ agent: "scout", task: "task", toolCallId: "call-1" });
  run.setModelProvenance({
    requested: "requested",
    resolved: Array.from({ length: 17 }, (_, i) => `model-${i}`),
    attempted: [],
    dispatch: [],
    response: [],
  });
  expect(projectInspection(store.snapshot()).activities[0]).toMatchObject({
    toolCallId: "call-1",
    model: {
      requested: "requested",
      resolved: Array.from({ length: 16 }, (_, i) => `model-${i + 1}`),
      attempted: [],
      observedDispatch: [],
      observedResponse: [],
      truncated: true,
    },
  });
});

it("omits unrepresentable model lists without claiming they are known empty", () => {
  const store = new AgentInspectorStore();
  const empty = store.start({ agent: "scout", task: "task" });
  empty.setModelProvenance({ resolved: [], attempted: [], dispatch: [], response: [] });
  const mixed = store.start({ agent: "scout", task: "task" });
  mixed.setModelProvenance({
    resolved: [null, ...Array.from({ length: 17 }, (_, i) => `model-${i}`)],
    attempted: [null, "attempted"],
    dispatch: ["dispatch"],
    response: ["response"],
  });
  const defaultModel = store.start({ agent: "scout", task: "task" });
  defaultModel.setModelProvenance({
    resolved: [null],
    attempted: [null],
    dispatch: [],
    response: [],
  });

  expect(projectInspection(store.snapshot()).activities.map((activity) => activity.model)).toEqual([
    { observedDispatch: [], observedResponse: [], truncated: true },
    { observedDispatch: ["dispatch"], observedResponse: ["response"], truncated: true },
    {
      resolved: [],
      attempted: [],
      observedDispatch: [],
      observedResponse: [],
      truncated: false,
    },
  ]);
});

it("keeps recent complete Unicode scalars within the shared text budget", () => {
  const store = new AgentInspectorStore();
  const run = store.start({ agent: "scout", task: "task" });
  run.appendText(`a${"😀".repeat(4096)}`);
  expect(projectInspection(store.snapshot()).activities[0]).toMatchObject({
    task: "",
    truncated: true,
    items: [{ text: "😀".repeat(4096), truncated: true }],
  });
});

it("selects the latest 100 items and reports source truncation", () => {
  const store = new AgentInspectorStore();
  const run = store.start({ agent: "scout", task: "task" });
  for (let i = 0; i < 101; i++) {
    run.messageStart(`response-${i}`);
    run.toolStart(`tool-${i}`, "read", {});
  }
  const activity = projectInspection(store.snapshot()).activities[0];
  expect(activity.items).toHaveLength(100);
  expect(activity.items[0]).toMatchObject({ sequence: 103, kind: "response", text: "response-51" });
  expect(activity.items.at(-1)).toMatchObject({ sequence: 202, kind: "tool", id: "tool-100" });
  expect(activity.omittedItems).toBe(100);
  expect(activity.truncated).toBe(true);
});

it("prioritizes the 64 newest active runs over terminal runs", () => {
  const store = new AgentInspectorStore();
  const terminal = store.start({ agent: "terminal", task: "task" });
  terminal.finish("completed", "unknown");
  for (let i = 0; i < 65; i++) store.start({ agent: `active-${i}`, task: "task" });
  const projection = projectInspection(store.snapshot());
  expect(projection.activities).toHaveLength(64);
  expect(projection.activities[0].title).toBe("active-64");
  expect(projection.activities.at(-1)?.title).toBe("active-1");
  expect(projection.omittedActivities).toBe(2);
});

it("includes known provenance and cleanup but excludes private source fields", () => {
  const store = new AgentInspectorStore();
  const run = store.start({
    agent: "scout",
    task: "task",
    model: "private-model",
    thinking: "low",
  });
  run.setArtifactPath("private-artifact");
  run.setModelProvenance({
    requested: "requested",
    resolved: ["resolved"],
    attempted: ["attempted"],
    dispatch: ["dispatch"],
    response: ["response"],
  });
  run.toolStart("tool", "read", { secret: "private-argument" });
  run.finish("aborted", "unknown");
  const activity = projectInspection(store.snapshot()).activities[0];
  expect(activity).toMatchObject({
    cleanup: "unknown",
    thinking: "low",
    model: {
      requested: "requested",
      resolved: ["resolved"],
      attempted: ["attempted"],
      observedDispatch: ["dispatch"],
      observedResponse: ["response"],
      truncated: false,
    },
  });
  expect(JSON.stringify(activity)).not.toMatch(
    /private-model|private-artifact|private-argument|"args"|"artifactPath"/,
  );
});

it("projects known default thinking for queued and running runs", () => {
  const store = new AgentInspectorStore();
  store.queue({ id: "queued", agent: "scout", task: "task", thinking: undefined });
  store.start({ agent: "scout", task: "task", thinking: undefined });
  store.start({ agent: "scout", task: "task", thinking: "off" });

  expect(
    projectInspection(store.snapshot()).activities.map((activity) => activity.thinking),
  ).toEqual(["off", "child-default", "child-default"]);
});

it("omits an activity with an invalid tool identity", () => {
  const store = new AgentInspectorStore();
  const run = store.start({ agent: "scout", task: "task" });
  run.toolStart("bad id", "read", {});
  expect(projectInspection(store.snapshot())).toEqual({ activities: [], omittedActivities: 1 });
});
