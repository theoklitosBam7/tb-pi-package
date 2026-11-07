import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { isInspectionRequest, isInspectionPublication } from "./inspection-contract.js";

describe("inspection v1 contract", () => {
  it("accepts an attach and empty snapshot, and rejects malformed values", () => {
    const attach = { version: 1, kind: "attach", requestId: "req-1", generation: "gen-1" };
    const snapshot = {
      version: 1,
      kind: "snapshot",
      requestId: "req-1",
      generation: "gen-1",
      providerId: "org.example.subagent",
      epoch: "epoch-1",
      revision: 0,
      capabilities: ["replacement", "removal"],
      activities: [],
      omittedActivities: 0,
    };
    expect(isInspectionRequest(attach)).toBe(true);
    expect(isInspectionPublication(snapshot)).toBe(true);
    expect(isInspectionRequest({ ...attach, version: 2 })).toBe(false);
    expect(isInspectionRequest({ ...attach, extra: null })).toBe(false);
    expect(
      isInspectionPublication({
        ...snapshot,
        activities: [
          {
            id: "a",
            title: "x",
            task: null,
            state: "running",
            items: [],
            omittedItems: 0,
            truncated: false,
          },
        ],
      }),
    ).toBe(false);
  });

  it("validates the shared versioned acceptance and rejection fixtures", () => {
    const fixtures: unknown = JSON.parse(
      readFileSync(new URL("./inspection-conformance-fixtures.json", import.meta.url), "utf8"),
    );
    const schema = Type.Object(
      {
        version: Type.Literal(1),
        cases: Type.Array(
          Type.Object(
            {
              name: Type.String({ minLength: 1 }),
              target: Type.Union([Type.Literal("request"), Type.Literal("publication")]),
              expectedValid: Type.Boolean(),
              message: Type.Unknown(),
            },
            { additionalProperties: false },
          ),
          { minItems: 1 },
        ),
      },
      { additionalProperties: false },
    );
    if (!Value.Check(schema, fixtures)) throw new Error("Invalid conformance fixture corpus.");
    expect(new Set(fixtures.cases.map((fixture) => fixture.name)).size).toBe(fixtures.cases.length);
    for (const target of ["request", "publication"]) {
      for (const expectedValid of [true, false]) {
        expect(
          fixtures.cases.some(
            (fixture) => fixture.target === target && fixture.expectedValid === expectedValid,
          ),
        ).toBe(true);
      }
    }
    for (const fixture of fixtures.cases) {
      const validate = fixture.target === "request" ? isInspectionRequest : isInspectionPublication;
      expect(validate(fixture.message), fixture.name).toBe(fixture.expectedValid);
    }
  });

  it("rejects symbol properties on requests", () => {
    const request = {
      version: 1,
      kind: "attach",
      requestId: "r",
      generation: "g",
      [Symbol("hidden")]: 1,
    };
    expect(isInspectionRequest(request)).toBe(false);
  });

  it("rejects sparse arrays that serialize to null", () => {
    const sparse: unknown[] = [];
    sparse.length = 1;
    const snapshot = {
      version: 1,
      kind: "snapshot",
      requestId: "r",
      generation: "g",
      providerId: "p",
      epoch: "e",
      revision: 0,
      capabilities: ["replacement", "removal"],
      activities: sparse,
      omittedActivities: 0,
    };
    expect(isInspectionPublication(snapshot)).toBe(false);
  });

  it("rejects a compact JSON envelope that exceeds the encoded limit", () => {
    const activities = Array.from({ length: 64 }, (_, i) => ({
      id: `run-${i}`,
      title: "a",
      state: "running",
      items: [{ kind: "response", sequence: 1, text: "\u0001".repeat(16000), truncated: false }],
      omittedItems: 0,
      truncated: false,
    }));
    const snapshot = {
      version: 1,
      kind: "snapshot",
      requestId: "r",
      generation: "g",
      providerId: "p",
      epoch: "e",
      revision: 0,
      capabilities: ["replacement", "removal"],
      activities,
      omittedActivities: 0,
    };
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeGreaterThan(524288);
    expect(isInspectionPublication(snapshot)).toBe(false);
  });

  it("accepts 524288 encoded bytes and rejects 524289 encoded bytes", () => {
    const activities = Array.from({ length: 33 }, (_, index) => ({
      id: `run-${index}`,
      title: "a",
      state: "running",
      items: [
        {
          kind: "response",
          sequence: 1,
          text: index < 32 ? "a".repeat(16000) : "",
          truncated: false,
        },
      ],
      omittedItems: 0,
      truncated: false,
    }));
    const snapshot = {
      version: 1,
      kind: "snapshot",
      requestId: "r",
      generation: "g",
      providerId: "p",
      epoch: "e",
      revision: 0,
      capabilities: ["replacement", "removal"],
      activities,
      omittedActivities: 0,
    };
    activities[32].items[0].text = "a".repeat(524288 - Buffer.byteLength(JSON.stringify(snapshot)));
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBe(524288);
    expect(isInspectionPublication(snapshot)).toBe(true);
    activities[32].items[0].text += "a";
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBe(524289);
    expect(isInspectionPublication(snapshot)).toBe(false);
  });

  it("enforces ASCII text, item, and activity count limits", () => {
    const activity = {
      id: "run-1",
      title: "scout",
      state: "running",
      items: [{ kind: "response", sequence: 1, text: "a".repeat(16384), truncated: false }],
      omittedItems: 0,
      truncated: false,
    };
    const snapshot = {
      version: 1,
      kind: "snapshot",
      requestId: "r",
      generation: "g",
      providerId: "p",
      epoch: "e",
      revision: 0,
      capabilities: ["replacement", "removal"],
      activities: [activity],
      omittedActivities: 0,
    };
    expect(isInspectionPublication(snapshot)).toBe(true);
    expect(
      isInspectionPublication({
        ...snapshot,
        activities: [{ ...activity, items: [{ ...activity.items[0], text: "a".repeat(16385) }] }],
      }),
    ).toBe(false);
    expect(
      isInspectionPublication({
        ...snapshot,
        activities: Array.from({ length: 65 }, (_, index) => ({
          ...activity,
          id: `run-${index}`,
          items: [],
        })),
      }),
    ).toBe(false);
    expect(
      isInspectionPublication({
        ...snapshot,
        activities: [
          {
            ...activity,
            items: Array.from({ length: 101 }, (_, index) => ({
              ...activity.items[0],
              sequence: index + 1,
              text: "",
            })),
          },
        ],
      }),
    ).toBe(false);
  });

  it("enforces activity ordering, identity and decoded byte budgets", () => {
    const a = {
      id: "run-1",
      title: "scout",
      state: "running",
      items: [{ kind: "response", sequence: 1, text: "😀".repeat(4096), truncated: false }],
      omittedItems: 0,
      truncated: false,
    };
    const b = {
      version: 1,
      kind: "batch",
      generation: "gen",
      providerId: "provider",
      epoch: "epoch",
      revision: 1,
      upserts: [a],
      removals: [],
      omittedActivities: 0,
    };
    expect(isInspectionPublication(b)).toBe(true);
    expect(isInspectionPublication({ ...b, removals: ["run-1"] })).toBe(false);
    expect(
      isInspectionPublication({
        ...b,
        upserts: [{ ...a, items: [{ ...a.items[0], text: "😀".repeat(4097) }] }],
      }),
    ).toBe(false);
    expect(
      isInspectionPublication({ ...b, upserts: [{ ...a, items: [a.items[0], a.items[0]] }] }),
    ).toBe(false);
    expect(isInspectionPublication({ ...b, upserts: [{ ...a, title: "\ud800" }] })).toBe(false);
  });
});
