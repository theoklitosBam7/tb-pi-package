import semver from "semver";

export function minimumVersion(range, { label = "version range" } = {}) {
  const errorMessage = `Invalid ${label}: ${String(range)}`;
  if (typeof range !== "string") throw new Error(errorMessage);

  let minimum;
  try {
    const parsed = new semver.Range(range);
    const fullRangeMinimum = semver.minVersion(parsed);
    if (fullRangeMinimum && parsed.test(fullRangeMinimum.version)) minimum = fullRangeMinimum;

    // An unsatisfiable alternative must not hide a valid minimum in another one.
    for (const comparators of parsed.set) {
      const alternative = comparators.map((comparator) => comparator.value).join(" ");
      const candidate = semver.minVersion(alternative);
      if (
        candidate &&
        parsed.test(candidate.version) &&
        (!minimum || semver.lt(candidate, minimum))
      ) {
        minimum = candidate;
      }
    }
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
