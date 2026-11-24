/**
 * Return a mutable array as required by Pi 1.4's Component.render() contract.
 * Copy the input because newer Pi versions can return cached readonly lines.
 */
export function copyRenderLines(lines: readonly string[]): string[] {
  return [...lines];
}
