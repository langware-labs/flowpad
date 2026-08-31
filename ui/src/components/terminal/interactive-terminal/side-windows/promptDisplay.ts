/**
 * Display normalization for the Prompts index.
 *
 * PRESENTATION ONLY — nothing here touches how a turn is stored. The JSONL
 * transcript and the ``transcript/prompts`` payload stay byte-identical; this
 * module decides how that payload READS in the side window.
 *
 * A typed slash command reaches the transcript as TWO user rows, and both are
 * faithful records worth keeping on disk:
 *
 *   1. the command itself, as a tag envelope —
 *      `<command-message>rca</command-message>`
 *      `<command-name>/rca</command-name>`
 *      `<command-args>why does the tab reopen</command-args>`
 *   2. an `is_meta` row carrying the whole expanded SKILL.md, which is what
 *      the model actually read.
 *
 * Row 1 is the human turn; row 2 is the harness quoting a file at it. The
 * index wants "what did I send", so it renders row 1 back as `/rca why does
 * the tab reopen` and hides row 2.
 */

const COMMAND_ENVELOPE_PREFIX = '<command-';
const COMMAND_NAME_RE = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;

/**
 * Flowpad's embedded-agent wrapper: the agent's instructions flattened into
 * the prompt with the human's own text appended under `# User message`. The
 * backend marks it `is_meta` (the chat collapses it to a chip), but the tail
 * IS the human turn — so the index shows that tail rather than dropping the
 * row. Without this, headless vibe sessions index no prompts at all.
 */
const EMBEDDED_AGENT_PREFIXES = ["# You are the '", '# Embedded agent specs'];
const USER_MESSAGE_MARKER = '\n# User message\n';

/** `<command-name>/rca</command-name>…` → `/rca <args>`; null if not an envelope. */
export function slashCommandText(text: string): string | null {
  if (!text.trimStart().startsWith(COMMAND_ENVELOPE_PREFIX)) return null;
  const name = COMMAND_NAME_RE.exec(text)?.[1]?.trim();
  if (!name) return null;
  const args = COMMAND_ARGS_RE.exec(text)?.[1]?.trim() ?? '';
  return args ? `${name} ${args}` : name;
}

/** The human text buried in an embedded-agent wrapper; null if not one. */
export function embeddedAgentUserMessage(text: string): string | null {
  if (!text.includes(USER_MESSAGE_MARKER)) return null;
  if (!EMBEDDED_AGENT_PREFIXES.some((p) => text.startsWith(p))) return null;
  return text.split(USER_MESSAGE_MARKER).slice(1).join(USER_MESSAGE_MARKER).trim();
}

/**
 * How one transcript user row should read in the Prompts index — or `null`
 * when it is not a prompt the human sent and the index should skip it.
 */
// `isMeta` is optional because the transcript entry is the server payload
// verbatim (no client-side constructor to default it), and rows written before
// the field existed simply omit it. Absent means "not framework-injected" —
// the same default the retired UserMessage class applied via `?? false`.
export function promptDisplayText(text: string, isMeta?: boolean): string | null {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return null;
  const slash = slashCommandText(trimmed);
  if (slash !== null) return slash;
  const embedded = embeddedAgentUserMessage(trimmed);
  if (embedded !== null) return embedded || null;
  return isMeta ? null : trimmed;
}
