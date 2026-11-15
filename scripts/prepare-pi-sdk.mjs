import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const version = process.argv[2];
const target = process.argv[3] ? path.resolve(process.argv[3]) : undefined;

if (!version || !target) {
  throw new Error("Usage: node scripts/prepare-pi-sdk.mjs <version> <target-directory>");
}

fs.mkdirSync(target, { recursive: true });
fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ private: true }));

// Send the install output to stderr so stdout carries only the parsed path line.
execFileSync(
  "pnpm",
  [
    "add",
    "--config.minimumReleaseAge=0",
    "--config.strictDepBuilds=false",
    `@earendil-works/pi-agent-core@${version}`,
    `@earendil-works/pi-ai@${version}`,
    `@earendil-works/pi-coding-agent@${version}`,
    `@earendil-works/pi-tui@${version}`,
  ],
  { cwd: target, stdio: ["inherit", 2, 2] },
);

const root = path.join(target, "node_modules", "@earendil-works", "pi-coding-agent");

console.log(`path=${fs.realpathSync(root)}`);
