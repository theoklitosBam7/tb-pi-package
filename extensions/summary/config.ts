import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { Type, type Static } from "typebox";
import { isMissingFileError } from "../lib/isMissingFileError.js";

const SummaryConfigSchema = Type.Object(
  {
    provider: Type.String({ minLength: 1, pattern: "^\\S(?:[\\s\\S]*\\S)?$" }),
    model: Type.String({ minLength: 1, pattern: "^\\S(?:[\\s\\S]*\\S)?$" }),
    // Pi's extension loader supports the package root, not this schema's subpath.
    thinking: Type.Enum([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ] satisfies ModelThinkingLevel[]),
  },
  { additionalProperties: false },
);
export type SummaryConfig = Static<typeof SummaryConfigSchema>;
export const DEFAULT_SUMMARY_CONFIG: SummaryConfig = {
  provider: "openai",
  model: "gpt-6-luna",
  thinking: "medium",
};
export function summaryConfigPath(): string {
  return join(getAgentDir(), "summary.json");
}
function invalidConfigMessage(path: string): string {
  return `${path}: expected only provider and model as nonempty strings without surrounding whitespace, and thinking as off, minimal, low, medium, high, xhigh, or max. Fix or remove this file`;
}

export async function loadSummaryConfig(path: string): Promise<SummaryConfig> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return { ...DEFAULT_SUMMARY_CONFIG };
    }
    throw new Error(`Cannot read summary config ${path}. Check the file and its permissions`, {
      cause: error,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(`${path}: invalid JSON. Fix or remove this file`, { cause: error });
  }
  if (!Value.Check(SummaryConfigSchema, value)) {
    throw new Error(invalidConfigMessage(path));
  }
  return value;
}

export async function saveSummaryConfig(
  path: string,
  config: SummaryConfig,
  options: { allowInvalidExisting?: boolean } = {},
): Promise<void> {
  if (!Value.Check(SummaryConfigSchema, config)) {
    throw new Error(invalidConfigMessage(path));
  }
  await withFileMutationQueue(path, async () => {
    // Refuse to replace a config that cannot be read or validated.
    if (!options.allowInvalidExisting) await loadSummaryConfig(path);
    const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    let ownsTemporaryFile = false;
    try {
      await mkdir(dirname(path), { recursive: true });
      const file = await open(temporaryPath, "wx", 0o600);
      ownsTemporaryFile = true;
      try {
        await file.writeFile(`${JSON.stringify(config, null, 2)}\n`);
      } finally {
        await file.close();
      }
      await rename(temporaryPath, path);
    } catch (error) {
      throw new Error(
        `Cannot save summary config ${path}. Check directory permissions and available disk space`,
        { cause: error },
      );
    } finally {
      if (ownsTemporaryFile) await rm(temporaryPath, { force: true });
    }
  });
}
