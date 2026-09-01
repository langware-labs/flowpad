/**
 * The line tag the PTY writer prefixes onto each emitted line, and its parser.
 *
 * A tag is a fixed-width `{t:<iso>,l:<0000>,r:<0000>}` prefix carrying the
 * write timestamp, the logical line number and the buffer row, so the
 * simulator can reconstruct where a line landed without replaying xterm.
 */
export const TAG_LENGTH = 42;

export function parseTag(line: string): {
  timestamp: number;
  logicalLine: number;
  bufferRow: number;
} | null {
  if (line.length < TAG_LENGTH) return null;
  const tag = line.slice(0, TAG_LENGTH);
  const m = tag.match(/^\{t:([^,]+),l:(\d{4}),r:(\d{4})\}$/);
  if (!m) return null;
  return {
    timestamp: new Date(m[1]).getTime(),
    logicalLine: parseInt(m[2], 10),
    bufferRow: parseInt(m[3], 10),
  };
}
