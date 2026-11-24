import { minimumVersion } from "./semver-minimum.mjs";

const range = process.argv[2];
console.log(`version=${minimumVersion(range)}`);
