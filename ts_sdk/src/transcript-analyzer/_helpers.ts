/**
 * Shared parser/converter helpers — content normalization across workers.
 *
 * Mirrors flow_sdk/transcript_analyzer/_helpers.py.
 */

/**
 * Flatten a Claude/anthropic-style content field to plain text.
 *
 * Accepts:
 *   - string — returned as-is.
 *   - list of blocks — concatenates {type:"text", text:"..."} blocks
 *     with "\n". Non-text blocks are skipped.
 *   - anything else — best-effort String(...).
 */
export function extract_text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
        parts.push(String((block as { text?: unknown }).text ?? ''));
      }
    }
    return parts.join('\n');
  }
  return String(content);
}

/**
 * Concatenate {type:"thinking"} blocks from a content list. Returns null
 * if no thinking block is present.
 */
export function extract_thinking(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'thinking') {
      const b = block as { thinking?: unknown; text?: unknown };
      parts.push(String(b.thinking ?? b.text ?? ''));
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * Flatten a tool_result content field to plain text. Same semantics as
 * extract_text — kept as a separate name to mirror the Python module.
 */
export function flatten_tool_result(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
        parts.push(String((block as { text?: unknown }).text ?? ''));
      }
    }
    return parts.join('\n');
  }
  return String(content);
}

/** Return the first {type: <block_type>} block in a content list, or {}. */
export function first_block_of_type(
  content: unknown,
  block_type: string,
): Record<string, unknown> {
  if (!Array.isArray(content)) return {};
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === block_type) {
      return block as Record<string, unknown>;
    }
  }
  return {};
}
