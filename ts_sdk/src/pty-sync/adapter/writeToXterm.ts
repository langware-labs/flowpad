import type { Terminal } from '@xterm/xterm';

/**
 * xterm.js treats bare \n as LF-only (cursor down, same column).
 * VirtualTerminal treats \n as CR+LF (cursor down + column 0).
 * Insert \r before any \n not already preceded by \r so both behave the same.
 *
 * Two-pass: count insertions first, then fill a pre-allocated Uint8Array.
 * Returns the original array unchanged when no bare LFs are found.
 */
export function crLfify(data: Uint8Array): Uint8Array {
  let extra = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x0a && (i === 0 || data[i - 1] !== 0x0d)) extra++;
  }
  if (extra === 0) return data;
  const out = new Uint8Array(data.length + extra);
  let w = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x0a && (i === 0 || data[i - 1] !== 0x0d)) out[w++] = 0x0d;
    out[w++] = data[i];
  }
  return out;
}

/**
 * Write a PTY output chunk to xterm, normalising bare \n → \r\n to match
 * VirtualTerminal's CR+LF behaviour.
 *
 * Awaitable: resolves when xterm has finished processing the data internally.
 * This is important for sequential chunk playback — xterm's write queue is
 * async, and fire-and-forget writes can produce out-of-order rendering.
 *
 * @example
 * for (const { chunk } of enriched.chunks) {
 *   await writeToXterm(term, chunk.data);
 * }
 * adapter.setEvictionOffset(report.totalScrolledOff);
 */
export function writeToXterm(term: Terminal, data: Uint8Array): Promise<void> {
  return new Promise<void>(resolve => term.write(crLfify(data), resolve));
}
