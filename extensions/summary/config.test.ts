import { mkdtemp, rm, writeFile, mkdir, chmod, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadSummaryConfig, saveSummaryConfig } from "./config.js";

describe("summary config", () => {
  let directory: string;
  let path: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "summary-config-"));
    path = join(directory, "summary.json");
  });
  afterEach(async () => {
    await chmod(directory, 0o700);
    await rm(directory, { recursive: true, force: true });
  });

  test("missing config returns the exact defaults", async () => {
    expect(await loadSummaryConfig(path)).toEqual({
      provider: "openai",
      model: "gpt-6-luna",
      thinking: "medium",
    });
  });

  test("saved config survives reload with private file permissions", async () => {
    path = join(directory, "nested", "summary.json");
    const config = { provider: "anthropic", model: "example-model", thinking: "max" } as const;
    await saveSummaryConfig(path, config);
    expect(await loadSummaryConfig(path)).toEqual(config);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("malformed JSON reports the config path and recovery action", async () => {
    await writeFile(path, "{");
    await expect(loadSummaryConfig(path)).rejects.toThrow(
      `${path}: invalid JSON. Fix or remove this file`,
    );
  });

  test("invalid config shapes are rejected with field guidance", async () => {
    for (const value of [
      null,
      [],
      {},
      { provider: "openai", model: "m" },
      { provider: " openai", model: "m", thinking: "medium" },
      { provider: "openai", model: "m ", thinking: "medium" },
      { provider: "", model: "m", thinking: "medium" },
      { provider: "openai", model: "m", thinking: "unknown" },
      { provider: "openai", model: "m", thinking: "medium", enabled: true },
    ]) {
      await writeFile(path, JSON.stringify(value));
      await expect(loadSummaryConfig(path)).rejects.toThrow(/provider.*model.*thinking/);
    }
  });

  test("save refuses to overwrite an invalid existing config", async () => {
    for (const content of ["{", "{}"]) {
      await writeFile(path, content);
      await expect(
        saveSummaryConfig(path, { provider: "openai", model: "m", thinking: "off" }),
      ).rejects.toThrow(path);
      await expect(loadSummaryConfig(path)).rejects.toThrow(path);
    }
  });

  test("read failures report the config path and an action", async () => {
    await mkdir(path);
    await expect(loadSummaryConfig(path)).rejects.toThrow(
      `Cannot read summary config ${path}. Check the file and its permissions`,
    );
  });

  test("write failure preserves the previous config and leaves no temporary file", async () => {
    const previous = { provider: "openai", model: "previous", thinking: "low" } as const;
    await saveSummaryConfig(path, previous);
    await chmod(directory, 0o500);
    try {
      await expect(saveSummaryConfig(path, { ...previous, model: "replacement" })).rejects.toThrow(
        `Cannot save summary config ${path}. Check directory permissions and available disk space`,
      );
      expect(await loadSummaryConfig(path)).toEqual(previous);
      expect(await readdir(directory)).toEqual(["summary.json"]);
    } finally {
      await chmod(directory, 0o700);
    }
  });

  test("save rejects invalid field values before replacing a valid config", async () => {
    const previous = { provider: "openai", model: "previous", thinking: "low" } as const;
    await saveSummaryConfig(path, previous);
    await expect(saveSummaryConfig(path, { ...previous, model: " " })).rejects.toThrow(
      /provider.*model.*thinking/,
    );
    expect(await loadSummaryConfig(path)).toEqual(previous);
  });
});
