import { visibleWidth, type Component } from "@earendil-works/pi-tui";

export class LeftGutter implements Component {
  constructor(
    private readonly child: Component,
    private readonly border: (text: string) => string,
  ) {}

  invalidate(): void {
    this.child.invalidate();
  }

  render(width: number): string[] {
    if (width < 2) return [...this.child.render(width)];
    const prefix = width >= 3 ? `${this.border("▌")} ` : this.border("▌");
    const contentWidth = Math.max(1, width - visibleWidth(prefix));
    return this.child.render(contentWidth).map((line) => `${prefix}${line}`);
  }
}
