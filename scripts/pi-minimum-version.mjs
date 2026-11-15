import fs from "node:fs";
import semver from "semver";

const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
const range = manifest.peerDependencies?.["@earendil-works/pi-coding-agent"];
const minimum = typeof range === "string" ? semver.minVersion(range) : null;

if (!minimum) {
  throw new Error(`Invalid Pi peer range: ${String(range)}`);
}

console.log(`version=${minimum.version}`);
