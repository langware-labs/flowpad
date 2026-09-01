/**
 * Shell-quote a string — matches Python `shlex.quote` exactly.
 *
 * - empty string → `''`
 * - safe chars only (word chars + `@%+=:,./-`) → returned as-is
 * - otherwise → wrapped in single quotes, with `'` escaped as `'\''`
 *
 * Used to render command hints in the UI. Flowpad never builds the command a
 * worker actually runs on the client — the backend owns that (see
 * `flow_sdk/builtin/cli_workers/`).
 */
export function shellQuote(s: string): string {
  if (!s) return "''";
  if (!/[^\w@%+=:,.\/-]/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
