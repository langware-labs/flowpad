/**
 * `<prefix>-<ISO stamp>.<ext>`: a file name that sorts by time and never collides within a
 * second — `display-annotation-2026-11-02T13-26-05-123Z.png`. The ONE stamp for files the
 * UI mints itself (captures, recordings); the stamp is `toISOString()` with `:` and `.`
 * turned into `-` so it is a legal name everywhere.
 */
export function stampedFileName(prefix: string, ext: string, now = new Date()): string {
  return `${prefix}-${now.toISOString().replace(/[:.]/g, '-')}.${ext}`;
}
