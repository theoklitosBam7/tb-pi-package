import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectPiSdk } from "../test-support/pi-sdk.js";

const selectedSdk = selectPiSdk();
const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(
  pathToFileURL(selectedSdk.entryPath).href
);

if (typeof sdk.createEventBus !== "function") {
  throw new Error(`The selected Pi SDK at ${selectedSdk.root} does not export createEventBus`);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Pi SDK event bus contract", () => {
  it("[integration] delivers an emitted event to a listener", () => {
    const bus = sdk.createEventBus();
    const received: unknown[] = [];

    bus.on("workbench.test.contract", (value) => received.push(value));
    bus.emit("workbench.test.contract", { kind: "sample" });

    expect(received).toEqual([{ kind: "sample" }]);
  });

  it("[integration] does not await an asynchronous listener inside emit", async () => {
    const bus = sdk.createEventBus();
    const received: unknown[] = [];
    let releaseListener: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseListener = resolve;
    });

    bus.on("workbench.test.contract", async (value) => {
      await blocked;
      received.push(value);
    });
    bus.emit("workbench.test.contract", "payload");

    expect(received).toEqual([]);
    releaseListener();
    await vi.waitFor(() => expect(received).toEqual(["payload"]));
  });

  it("[integration] keeps delivering to other listeners when one throws", async () => {
    const bus = sdk.createEventBus();
    const received: unknown[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    bus.on("workbench.test.contract", () => {
      throw new Error("listener failed");
    });
    bus.on("workbench.test.contract", (value) => received.push(value));
    bus.emit("workbench.test.contract", "payload");

    await vi.waitFor(() => expect(received).toEqual(["payload"]));
    expect(consoleError).toHaveBeenCalledOnce();
  });

  it("[integration] stops delivery after unsubscribing", () => {
    const bus = sdk.createEventBus();
    const received: unknown[] = [];

    const unsubscribe = bus.on("workbench.test.contract", (value) => received.push(value));
    bus.emit("workbench.test.contract", "first");
    unsubscribe();
    bus.emit("workbench.test.contract", "second");

    expect(received).toEqual(["first"]);
  });
});
