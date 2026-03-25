import { SeededRng } from './SeededRng.js';

/** Fixed tag length: {t:2024-01-01T00:00:00.000Z,l:0001,r:0001} = 42 chars */
export const TAG_LENGTH = 42;

/**
 * Build a single test packet line.
 *
 * Format: <tag><padding>\n
 *   tag   = {t:<iso>,l:<logicalLine4d>,r:<bufferRow4d>}  (42 chars)
 *   padding = seeded words until totalChars characters reached (before \n)
 */
export function buildPacket(
  timestamp: number,
  logicalLine: number,
  bufferRow: number,
  totalChars: number,
  rng: SeededRng,
): string {
  if (totalChars < TAG_LENGTH) {
    throw new Error(`totalChars ${totalChars} < TAG_LENGTH ${TAG_LENGTH}`);
  }

  const iso = new Date(timestamp).toISOString(); // always 24 chars
  const l = String(logicalLine).padStart(4, '0');
  const r = String(bufferRow).padStart(4, '0');
  const tag = `{t:${iso},l:${l},r:${r}}`;

  if (tag.length !== TAG_LENGTH) {
    throw new Error(`Tag length mismatch: got ${tag.length}, expected ${TAG_LENGTH}. Tag: "${tag}"`);
  }

  const paddingNeeded = totalChars - TAG_LENGTH;
  let padding = '';
  while (padding.length < paddingNeeded) {
    padding += ' ' + rng.nextWord();
  }
  padding = padding.slice(0, paddingNeeded);

  return tag + padding + '\n';
}

/** Parse a tag from the start of a line. Returns null if not a valid tag. */
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
