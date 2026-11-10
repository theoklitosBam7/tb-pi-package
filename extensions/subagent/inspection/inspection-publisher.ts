import { randomBytes } from "node:crypto";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { AgentInspectorStatus, AgentInspectorStore } from "./inspector.js";
import {
  isInspectionPublication,
  isInspectionRequest,
  type InspectionRequest,
} from "./inspection-contract.js";
import { projectInspection, type InspectionProjection } from "./inspection-projection.js";

const requestChannel = "workbench.inspection.v1.request";
const publishChannel = "workbench.inspection.v1.publish";
const providerId = "org.tb-pi-package.subagent";
const terminal = new Set(["completed", "failed", "aborted", "timed out"]);

export function createInspectionPublisher({
  events,
  store,
}: {
  events: EventBus;
  store: AgentInspectorStore;
}): { dispose(): void } {
  const epoch = randomBytes(16).toString("hex");
  let attachment: InspectionRequest | undefined;
  let lastRequest: InspectionRequest | undefined;
  let unsubscribeStore: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let revision = 0;
  let committed: InspectionProjection = { activities: [], omittedActivities: 0 };
  let pending = false;
  let observedStatuses = new Map<string, AgentInspectorStatus>();
  const diagnostic = () => console.warn("Inspection publication failed.");
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const detach = () => {
    attachment = undefined;
    clearTimer();
    pending = false;
    observedStatuses.clear();
    unsubscribeStore?.();
    unsubscribeStore = undefined;
  };
  const capture = (): InspectionProjection => {
    const runs = store.snapshot();
    const projection = projectInspection(runs);
    const envelope = () => ({
      version: 1,
      kind: "snapshot",
      requestId: "x".repeat(128),
      generation: "x".repeat(128),
      providerId,
      epoch,
      revision: Number.MAX_SAFE_INTEGER,
      capabilities: ["replacement", "removal"],
      ...projection,
    });
    while (Buffer.byteLength(JSON.stringify(envelope())) > 491520 && projection.activities.length) {
      projection.activities.pop();
      projection.omittedActivities++;
    }
    if (Buffer.byteLength(JSON.stringify(envelope())) > 491520)
      throw new Error("inspection envelope exceeds limit");
    observedStatuses = new Map(runs.map((run) => [run.id, run.status]));
    return projection;
  };
  const changed = (a: InspectionProjection, b: InspectionProjection) =>
    JSON.stringify(a) !== JSON.stringify(b);
  const commit = (next: InspectionProjection) => {
    if (changed(committed, next)) {
      if (revision === Number.MAX_SAFE_INTEGER) throw new Error("inspection revision exhausted");
      revision++;
      committed = next;
    }
  };
  const emit = (message: unknown) => {
    if (!isInspectionPublication(message)) throw new Error("invalid inspection publication");
    events.emit(publishChannel, message);
  };
  const flush = () => {
    clearTimer();
    if (!attachment || !pending || disposed) return;
    try {
      pending = false;
      const next = capture();
      if (!changed(committed, next)) return;
      const previous = committed;
      commit(next);
      const old = new Map(previous.activities.map((a) => [a.id, a]));
      const current = new Set(next.activities.map((a) => a.id));
      const upserts = next.activities.filter(
        (a) => JSON.stringify(a) !== JSON.stringify(old.get(a.id)),
      );
      const removals = previous.activities.filter((a) => !current.has(a.id)).map((a) => a.id);
      emit({
        version: 1,
        kind: "batch",
        providerId,
        epoch,
        generation: attachment.generation,
        revision,
        upserts,
        removals,
        omittedActivities: next.omittedActivities,
      });
    } catch {
      diagnostic();
    }
  };
  const onChange = () => {
    if (!attachment || disposed) return;
    try {
      const runs = store.snapshot();
      const terminalTransition = runs.some(
        (run) => terminal.has(run.status) && !terminal.has(observedStatuses.get(run.id) ?? ""),
      );
      observedStatuses = new Map(runs.map((run) => [run.id, run.status]));
      pending = true;
      if (terminalTransition) flush();
      else if (timer === undefined) timer = setTimeout(flush, 100);
    } catch {
      diagnostic();
    }
  };
  const onRequest = (value: unknown) => {
    if (disposed || !isInspectionRequest(value)) return;
    if (
      lastRequest?.requestId === value.requestId &&
      (lastRequest.kind !== value.kind || lastRequest.generation !== value.generation)
    )
      return;
    lastRequest = value;
    if (value.kind === "detach") {
      if (attachment?.generation === value.generation) detach();
      return;
    }
    try {
      if (attachment?.generation !== value.generation) detach();
      attachment = value;
      unsubscribeStore ??= store.subscribe(onChange);
      clearTimer();
      pending = false;
      commit(capture());
      emit({
        version: 1,
        kind: "snapshot",
        providerId,
        epoch,
        generation: value.generation,
        revision,
        requestId: value.requestId,
        capabilities: ["replacement", "removal"],
        ...committed,
      });
    } catch {
      diagnostic();
    }
  };
  const unsubscribeRequest = events.on(requestChannel, onRequest);
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      detach();
      unsubscribeRequest();
    },
  };
}
