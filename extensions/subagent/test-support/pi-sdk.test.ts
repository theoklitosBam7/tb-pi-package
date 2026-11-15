import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { piSdkOverride, selectPiSdk } from "./pi-sdk.js";

const packageName = "@earendil-works/pi-coding-agent";
const temporaryDirectories: string[] = [];

function createSdkFixture({
  name = packageName,
  version = "9.9.9",
  withCli = true,
  withEntry = true,
}: {
  name?: string;
  version?: string;
  withCli?: boolean;
  withEntry?: boolean;
} = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-"));
  temporaryDirectories.push(root);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name, version, type: "module" }),
  );
  fs.mkdirSync(path.join(root, "dist"));
  if (withCli) fs.writeFileSync(path.join(root, "dist", "cli.js"), "// fixture\n");
  if (withEntry) fs.writeFileSync(path.join(root, "dist", "index.js"), "export {};\n");
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("piSdkOverride", () => {
  it("prefers PI_SDK_PATH and keeps INSPECTION_SDK_PATH as an alias", () => {
    expect(piSdkOverride({ PI_SDK_PATH: "/preferred", INSPECTION_SDK_PATH: "/legacy" })).toBe(
      "/preferred",
    );
    expect(piSdkOverride({ INSPECTION_SDK_PATH: "/legacy" })).toBe("/legacy");
    expect(piSdkOverride({ PI_SDK_PATH: "  ", INSPECTION_SDK_PATH: "/legacy" })).toBe("/legacy");
    expect(piSdkOverride({})).toBeUndefined();
    expect(piSdkOverride({ PI_SDK_PATH: "  " })).toBeUndefined();
  });
});

describe("selectPiSdk", () => {
  it("selects the workspace SDK when no override is set", () => {
    const sdk = selectPiSdk({});

    expect(path.basename(sdk.root)).toBe("pi-coding-agent");
    expect(JSON.parse(fs.readFileSync(path.join(sdk.root, "package.json"), "utf8")).name).toBe(
      packageName,
    );
    expect(sdk.cliPath).toBe(path.join(sdk.root, "dist", "cli.js"));
    expect(sdk.entryPath).toBe(path.join(sdk.root, "dist", "index.js"));
    expect(fs.existsSync(sdk.cliPath)).toBe(true);
    expect(fs.existsSync(sdk.entryPath)).toBe(true);
    expect(typeof sdk.version).toBe("string");
    expect(sdk.require.resolve("typebox")).toContain("typebox");
  });

  it("selects the SDK at PI_SDK_PATH", () => {
    const root = createSdkFixture({ version: "1.2.3" });
    const sdk = selectPiSdk({ PI_SDK_PATH: root });

    expect(sdk.root).toBe(fs.realpathSync(root));
    expect(sdk.version).toBe("1.2.3");
    expect(sdk.cliPath).toBe(path.join(fs.realpathSync(root), "dist", "cli.js"));
    expect(sdk.entryPath).toBe(path.join(fs.realpathSync(root), "dist", "index.js"));
  });

  it("selects the SDK at INSPECTION_SDK_PATH", () => {
    const root = createSdkFixture({ version: "1.4.0" });
    const sdk = selectPiSdk({ INSPECTION_SDK_PATH: root });

    expect(sdk.root).toBe(fs.realpathSync(root));
    expect(sdk.version).toBe("1.4.0");
  });

  it("rejects a package with another name", () => {
    const root = createSdkFixture({ name: "@earendil-works/pi-ai" });

    expect(() => selectPiSdk({ PI_SDK_PATH: root })).toThrow(
      /not the @earendil-works\/pi-coding-agent package/,
    );
  });

  it("rejects an SDK without the CLI", () => {
    const root = createSdkFixture({ withCli: false });

    expect(() => selectPiSdk({ PI_SDK_PATH: root })).toThrow(/has no CLI/);
  });

  it("rejects an SDK without the entry module", () => {
    const root = createSdkFixture({ withEntry: false });

    expect(() => selectPiSdk({ PI_SDK_PATH: root })).toThrow(/has no entry module/);
  });
});
