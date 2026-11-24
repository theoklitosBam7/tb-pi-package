import fs from "node:fs";
import { minimumVersion } from "./semver-minimum.mjs";

const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
const range = manifest.peerDependencies?.["@earendil-works/pi-coding-agent"];

console.log(`version=${minimumVersion(range, { label: "Pi peer range" })}`);
