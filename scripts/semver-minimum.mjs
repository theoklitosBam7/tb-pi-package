import semver from "semver";

export function minimumVersion(range, errorMessage = `Invalid version range: ${String(range)}`) {
  const minimum = typeof range === "string" ? semver.minVersion(range) : null;
  if (!minimum) {
    throw new Error(errorMessage);
  }

  return minimum.version;
}
