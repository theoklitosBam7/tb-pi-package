import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const scriptPath = fileURLToPath(new URL("./resolve-version.mjs", import.meta.url));

it("resolves the lowest valid version from alternative ranges", () => {
  const result = spawnSync(process.execPath, [scriptPath, ">=24.0.0 || ^22.22.3"], {
    encoding: "utf8",
  });

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("version=22.22.3\n");
});
