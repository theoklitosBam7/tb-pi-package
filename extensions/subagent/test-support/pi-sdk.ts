import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonRecord } from "./json-record.js";

const packageName = "@earendil-works/pi-coding-agent";

export interface PiSdk {
  root: string;
  cliPath: string;
  entryPath: string;
  version: string;
  require: NodeRequire;
}

export function piSdkOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.PI_SDK_PATH?.trim() || env.INSPECTION_SDK_PATH?.trim();
  return override === undefined || override.length === 0 ? undefined : override;
}

function findPackage(startDirectory: string, name: string): string {
  let directory = startDirectory;

  while (true) {
    const candidate = path.join(directory, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return fs.realpathSync(candidate);

    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(`Cannot find ${name} in a node_modules directory above ${startDirectory}`);
    }
    directory = parent;
  }
}

export function findPiDependency(sdk: PiSdk, name: string): string {
  return findPackage(sdk.root, name);
}

const loggedRoots = new Set<string>();

export function selectPiSdk(env: NodeJS.ProcessEnv = process.env): PiSdk {
  const override = piSdkOverride(env);
  const root = override
    ? fs.realpathSync(path.resolve(override))
    : findPackage(path.dirname(fileURLToPath(import.meta.url)), packageName);
  const manifestPath = path.join(root, "package.json");
  const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  if (!isJsonRecord(manifest) || manifest.name !== packageName) {
    throw new Error(`The selected SDK at ${root} is not the ${packageName} package`);
  }

  const cliPath = path.join(root, "dist", "cli.js");
  if (!fs.existsSync(cliPath)) {
    throw new Error(`The selected Pi SDK has no CLI at ${cliPath}`);
  }

  const entryPath = path.join(root, "dist", "index.js");
  if (!fs.existsSync(entryPath)) {
    throw new Error(`The selected Pi SDK has no entry module at ${entryPath}`);
  }

  const version = typeof manifest.version === "string" ? manifest.version : "unknown";
  if (!loggedRoots.has(root)) {
    loggedRoots.add(root);
    console.log(`Pi SDK ${version} at ${root}`);
  }

  return {
    root,
    cliPath,
    entryPath,
    version,
    require: createRequire(manifestPath),
  };
}
