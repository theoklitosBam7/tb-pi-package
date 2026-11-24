import semver from "semver";

export function minimumVersion(range, errorMessage = `Invalid version range: ${String(range)}`) {
  let minimum;
  try {
    minimum = typeof range === "string" ? semver.minVersion(range) : null;
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
    throw new Error(`${errorMessage} (${error.message})`);
  }

  if (!minimum) {
    throw new Error(errorMessage);
  }

  return minimum.version;
}
