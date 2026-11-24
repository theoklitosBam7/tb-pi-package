export function mutableLines(lines: readonly string[]): string[] {
  // SDK 1.4 requires a mutable array, while 1.6 may return a cached readonly array.
  return [...lines];
}
