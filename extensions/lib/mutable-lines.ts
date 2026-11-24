/** Copy render lines so callers can mutate them without changing the child's cached output. */
export function copyRenderLines(lines: readonly string[]): string[] {
  return [...lines];
}
