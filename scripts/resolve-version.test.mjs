import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const scriptPath = fileURLToPath(new URL("./resolve-version.mjs", import.meta.url));

it("[process integration] resolves the lowest valid version from alternative ranges", () => {
  const result = spawnSync(process.execPath, [scriptPath, ">=24.0.0 || ^22.22.3"], {
    encoding: "utf8",
  });

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("version=22.22.3\n");
});

it("[process integration] reports malformed version ranges with context", () => {
  const result = spawnSync(process.execPath, [scriptPath, "not-a-range"], {
    encoding: "utf8",
  });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Invalid version range: not-a-range");
  expect(result.stderr).toContain("Invalid comparator: not-a-range");
});
