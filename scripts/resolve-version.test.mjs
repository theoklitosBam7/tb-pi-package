import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const scriptPath = fileURLToPath(new URL("./resolve-version.mjs", import.meta.url));

it.each([
  [">=24.0.0 || ^22.22.3", "22.22.3"],
  [">=22.22.3 <22.22.3 || >=24.0.0", "24.0.0"],
  ["* || 0.0.0-alpha", "0.0.0"],
  [`>0.0.0-${"a".repeat(250)} <0.0.0 || 0.0.0`, "0.0.0"],
  [">=1.2.4-0 <1.2.4-0 || >1.2.3 <1.2.4-alpha || >=2.0.0", "1.2.4-0"],
])("[process integration] resolves the minimum of %s", (range, version) => {
  const result = spawnSync(process.execPath, [scriptPath, range], { encoding: "utf8" });

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(`version=${version}\n`);
});

it("[process integration] reports malformed version ranges with context", () => {
  const result = spawnSync(process.execPath, [scriptPath, "not-a-range"], {
    encoding: "utf8",
  });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Invalid version range: not-a-range");
  expect(result.stderr).toContain("Invalid comparator: not-a-range");
});
