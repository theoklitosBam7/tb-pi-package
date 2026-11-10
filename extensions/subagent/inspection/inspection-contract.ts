import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const object = { additionalProperties: false };
const id = Type.String({ pattern: "^[A-Za-z0-9._:-]{1,128}$" });
const integer = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const text = Type.String();
const strings = Type.Array(text, { maxItems: 16 });
const model = Type.Object(
  {
    requested: Type.Optional(text),
    resolved: Type.Optional(strings),
    attempted: Type.Optional(strings),
    observedDispatch: Type.Optional(strings),
    observedResponse: Type.Optional(strings),
    truncated: Type.Boolean(),
  },
  object,
);
const item = Type.Union([
  Type.Object(
    { kind: Type.Literal("response"), sequence: positive, text, truncated: Type.Boolean() },
    object,
  ),
  Type.Object(
    {
      kind: Type.Literal("tool"),
      sequence: positive,
      id,
      name: text,
      state: Type.Union([
        Type.Literal("running"),
        Type.Literal("completed"),
        Type.Literal("failed"),
        Type.Literal("aborted"),
      ]),
      output: text,
      truncated: Type.Boolean(),
    },
    object,
  ),
]);
const activity = Type.Object(
  {
    id,
    title: text,
    task: Type.Optional(text),
    parentId: Type.Optional(id),
    toolCallId: Type.Optional(id),
    state: Type.Union([
      Type.Literal("unknown"),
      Type.Literal("queued"),
      Type.Literal("running"),
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("aborted"),
      Type.Literal("timed-out"),
    ]),
    cleanup: Type.Optional(Type.Literal("unknown")),
    model: Type.Optional(model),
    thinking: Type.Optional(
      Type.Union([
        Type.Literal("child-default"),
        Type.Literal("off"),
        Type.Literal("minimal"),
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
        Type.Literal("xhigh"),
        Type.Literal("max"),
      ]),
    ),
    items: Type.Array(item, { maxItems: 100 }),
    omittedItems: integer,
    truncated: Type.Boolean(),
  },
  object,
);
const common = {
  version: Type.Literal(1),
  providerId: id,
  epoch: id,
  generation: id,
  revision: integer,
};
const request = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Union([Type.Literal("attach"), Type.Literal("detach")]),
    requestId: id,
    generation: id,
  },
  object,
);
const snapshot = Type.Object(
  {
    ...common,
    kind: Type.Literal("snapshot"),
    requestId: id,
    capabilities: Type.Tuple([Type.Literal("replacement"), Type.Literal("removal")]),
    activities: Type.Array(activity, { maxItems: 64 }),
    omittedActivities: integer,
  },
  object,
);
const batch = Type.Object(
  {
    ...common,
    kind: Type.Literal("batch"),
    upserts: Type.Array(activity, { maxItems: 64 }),
    removals: Type.Array(id, { maxItems: 64 }),
    omittedActivities: integer,
  },
  object,
);
const publication = Type.Union([snapshot, batch]);
export type InspectionRequest = Static<typeof request>;
export type InspectionActivity = Static<typeof activity>;
export type InspectionPublication = Static<typeof publication>;

function plainJson(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === "string")
    return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (typeof value !== "object" || value === null || seen.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  seen.add(value);
  const valid = (Array.isArray(value) ? value : Object.values(value)).every((entry) =>
    plainJson(entry, seen),
  );
  seen.delete(value);
  return valid;
}
function bounded(value: string, min: number, max: number): boolean {
  const size = Buffer.byteLength(value, "utf8");
  return size >= min && size <= max;
}
function validActivity(a: InspectionActivity): boolean {
  if (
    !bounded(a.title, 1, 256) ||
    (a.task !== undefined && !bounded(a.task, 0, 4096)) ||
    a.parentId === a.id
  )
    return false;
  if (a.model) {
    if (a.model.requested !== undefined && !bounded(a.model.requested, 1, 256)) return false;
    for (const list of [
      a.model.resolved,
      a.model.attempted,
      a.model.observedDispatch,
      a.model.observedResponse,
    ])
      if (list?.some((s) => !bounded(s, 1, 256))) return false;
  }
  let size = Buffer.byteLength(a.task ?? "");
  let sequence = 0;
  const ids = new Set<string>();
  for (const entry of a.items) {
    if (entry.sequence <= sequence) return false;
    sequence = entry.sequence;
    const content = entry.kind === "response" ? entry.text : entry.output;
    if (!bounded(content, 0, 16384)) return false;
    size += Buffer.byteLength(content);
    if (entry.kind === "tool") {
      if (ids.has(entry.id) || !bounded(entry.name, 1, 256)) return false;
      ids.add(entry.id);
    }
  }
  return size <= 16384;
}
export function isInspectionRequest(value: unknown): value is InspectionRequest {
  try {
    return (
      plainJson(value) &&
      Value.Check(request, value) &&
      Buffer.byteLength(JSON.stringify(value)) <= 524288
    );
  } catch {
    return false;
  }
}
export function isInspectionPublication(value: unknown): value is InspectionPublication {
  try {
    if (
      !plainJson(value) ||
      !Value.Check(publication, value) ||
      Buffer.byteLength(JSON.stringify(value)) > 524288
    )
      return false;
    const activities = value.kind === "snapshot" ? value.activities : value.upserts;
    const ids = new Set<string>();
    for (const a of activities) {
      if (ids.has(a.id) || !validActivity(a)) return false;
      ids.add(a.id);
    }
    if (value.kind === "batch")
      for (const id of value.removals) {
        if (ids.has(id)) return false;
        ids.add(id);
      }
    return true;
  } catch {
    return false;
  }
}
