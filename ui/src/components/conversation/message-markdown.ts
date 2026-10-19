/**
 * Message text is written as chat: a single newline is a line break. Markdown
 * would join those lines, so outside code fences each lone newline becomes a
 * hard break before the text is rendered as markdown.
 */
export function withHardBreaks(text: string): string {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) => (i % 2 ? part : part.replace(/([^\n])\n(?!\n)/g, '$1  \n')))
    .join('');
}

/** One plain line for a preview: markdown marks dropped, a link reads as its label. */
export function markdownToPlain(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Two messages read as one group: same sender, a few minutes apart. */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

export function continuesGroup(
  prev: { sender_id?: string | null; at: number } | null,
  cur: { sender_id?: string | null; at: number },
): boolean {
  return (
    !!prev &&
    !!cur.sender_id &&
    prev.sender_id === cur.sender_id &&
    cur.at >= prev.at &&
    cur.at - prev.at <= GROUP_WINDOW_MS
  );
}
