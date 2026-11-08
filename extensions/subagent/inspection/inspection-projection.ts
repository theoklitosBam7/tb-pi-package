import type { AgentInspectorStore } from "./inspector.js";
import type { InspectionActivity } from "./inspection-contract.js";

const validId = (value: string) => /^[A-Za-z0-9._:-]{1,128}$/.test(value);
function tail(value: string, limit: number): { value: string; truncated: boolean } {
  const scalars = Array.from(value, (scalar) => (/^[\uD800-\uDFFF]$/.test(scalar) ? "�" : scalar));
  let bytes = 0;
  let start = scalars.length;
  while (start > 0) {
    const size = Buffer.byteLength(scalars[start - 1]);
    if (bytes + size > limit) break;
    bytes += size;
    start--;
  }
  return {
    value: scalars.slice(start).join(""),
    truncated: start > 0 || scalars.join("") !== value,
  };
}
type Run = ReturnType<AgentInspectorStore["snapshot"]>[number];
export interface InspectionProjection {
  activities: InspectionActivity[];
  omittedActivities: number;
}

function projectRun(run: Run): InspectionActivity | undefined {
  if (!validId(run.id) || (run.toolCallId !== undefined && !validId(run.toolCallId)))
    return undefined;
  const title = tail(run.agent, 256);
  if (!title.value) return undefined;
  let truncated = title.truncated || run.activityTruncated || run.sourceTextTruncated;
  const all = [
    ...run.responses.map((r) => ({ kind: "response" as const, source: r })),
    ...run.tools.map((t) => ({ kind: "tool" as const, source: t })),
  ].sort((a, b) => a.source.sequence - b.source.sequence);
  const selected = all.slice(-100);
  const items: InspectionActivity["items"] = [];
  let budget = 16384;
  for (const entry of selected.reverse()) {
    const source = entry.source;
    if (!Number.isSafeInteger(source.sequence) || source.sequence < 1) return undefined;
    if (entry.kind === "response") {
      const value = tail(entry.source.text, budget);
      budget -= Buffer.byteLength(value.value);
      items.unshift({
        kind: "response",
        sequence: source.sequence,
        text: value.value,
        truncated: value.truncated || entry.source.truncated,
      });
      truncated ||= value.truncated || entry.source.truncated;
    } else {
      if (!validId(entry.source.id)) return undefined;
      const name = tail(entry.source.name, 256);
      if (
        !name.value ||
        !["running", "completed", "failed", "aborted"].includes(entry.source.status)
      )
        return undefined;
      const value = tail(entry.source.output, budget);
      budget -= Buffer.byteLength(value.value);
      const state =
        entry.source.status === "running" ||
        entry.source.status === "completed" ||
        entry.source.status === "aborted"
          ? entry.source.status
          : "failed";
      items.unshift({
        kind: "tool",
        sequence: source.sequence,
        id: entry.source.id,
        name: name.value,
        state,
        output: value.value,
        truncated: value.truncated || entry.source.truncated,
      });
      truncated ||= value.truncated || entry.source.truncated || name.truncated;
    }
  }
  const task = tail(run.task, Math.min(4096, budget));
  truncated ||= task.truncated || all.length > 100;
  const provenance = run.modelProvenance;
  let model: InspectionActivity["model"];
  if (provenance) {
    let modelTruncated = false;
    const list = (values: (string | null)[]) => {
      if (!values.every((value) => value !== null)) {
        modelTruncated = true;
        return undefined;
      }
      return values.slice(-16).flatMap((v) => {
        const result = tail(v, 256);
        modelTruncated ||= result.truncated || !result.value;
        return result.value ? [result.value] : [];
      });
    };
    const requested =
      provenance.requested === undefined ? undefined : tail(provenance.requested, 256);
    if (requested) modelTruncated ||= requested.truncated || !requested.value;
    const resolved = list(provenance.resolved);
    const attempted = list(provenance.attempted);
    const observedDispatch = list(provenance.dispatch);
    const observedResponse = list(provenance.response);
    modelTruncated ||= [
      provenance.resolved,
      provenance.attempted,
      provenance.dispatch,
      provenance.response,
    ].some((v) => v.length > 16);
    model = {
      ...(requested?.value ? { requested: requested.value } : {}),
      ...(resolved !== undefined ? { resolved } : {}),
      ...(attempted !== undefined ? { attempted } : {}),
      ...(observedDispatch !== undefined ? { observedDispatch } : {}),
      ...(observedResponse !== undefined ? { observedResponse } : {}),
      truncated: modelTruncated,
    };
  }
  return {
    id: run.id,
    title: title.value,
    task: task.value,
    ...(run.toolCallId !== undefined ? { toolCallId: run.toolCallId } : {}),
    state: run.status === "timed out" ? "timed-out" : run.status,
    ...(run.cleanup ? { cleanup: run.cleanup } : {}),
    thinking: run.thinking ?? "child-default",
    ...(model ? { model } : {}),
    items,
    omittedItems: all.length - items.length,
    truncated,
  };
}
export function projectInspection(
  runs: ReturnType<AgentInspectorStore["snapshot"]>,
): InspectionProjection {
  const ordered = [
    ...runs.filter((r) => r.status === "running" || r.status === "queued"),
    ...runs.filter((r) => r.status !== "running" && r.status !== "queued"),
  ];
  const activities: InspectionActivity[] = [];
  for (const run of ordered) {
    if (activities.length === 64) break;
    const activity = projectRun(run);
    if (activity) activities.push(activity);
  }
  return { activities, omittedActivities: runs.length - activities.length };
}
