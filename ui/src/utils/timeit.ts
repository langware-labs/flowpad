/**
 * TimeIt — lightweight step-by-step timing utility (mirrors flow_sdk/utils/timeit.py).
 *
 * Usage:
 *   const t = new TimeIt('Home load');
 *   await initSdk(params);
 *   t.time('initSdk');
 *   await ensureComputeNodeLoaded();
 *   t.time('ensureComputeNode');
 *   t.done(0.5); // logs report only if total > 500ms
 */
export class TimeIt {
  private readonly name: string;
  private readonly start: number;
  private last: number;
  private readonly steps: Array<{ label: string; ms: number }> = [];

  constructor(name: string) {
    this.name = name;
    this.start = performance.now();
    this.last = this.start;
  }

  /** Record elapsed ms since last call (or construction). Returns ms elapsed. */
  time(label: string): number {
    const now = performance.now();
    const ms = now - this.last;
    this.steps.push({ label, ms });
    this.last = now;
    return ms;
  }

  /** Log report if total elapsed exceeds threshold seconds (default 0.5s). */
  done(thresholdSeconds = 0.5): void {
    const totalMs = performance.now() - this.start;
    if (totalMs < thresholdSeconds * 1000) return;

    const width = Math.max(...this.steps.map((s) => s.label.length), 20) + 2;
    const sep = '─'.repeat(width + 12);
    const lines: string[] = [
      sep,
      `  ${this.name} slowness detected (${totalMs.toFixed(0)}ms > ${(thresholdSeconds * 1000).toFixed(0)}ms threshold)`,
      sep,
      ...this.steps.map(({ label, ms }) => {
        const bar = '█'.repeat(Math.min(Math.floor(ms / 10), 40));
        return `  ${label.padEnd(width)} ${ms.toFixed(1).padStart(7)}ms  ${bar}`;
      }),
      sep,
      `  ${'TOTAL'.padEnd(width)} ${totalMs.toFixed(1).padStart(7)}ms`,
      sep,
    ];
    console.warn(lines.join('\n'));
  }
}
