import type { IBuffer, IBufferLine, IBufferRange, ILink, ILinkProvider, Terminal } from '@xterm/xterm';

type ActivateLink = (event: MouseEvent, link: string) => void;

/** What a terminal does with its links. */
export interface TerminalLinkHandlers {
  activate: ActivateLink;
  /** Right-click on a link: the terminal has already claimed the event. */
  openMenu: (link: string, clientX: number, clientY: number) => void;
}

/** WebLinksAddon's default URL pattern; one provider serves click and right-click alike. */
const URL_REGEX = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/;
const POSITION = String.raw`(?::\d+(?::\d+)?|#L\d+)`;
const BARE_FILE = new RegExp(String.raw`^[\w@.-]+\.(?:[A-Za-z][\w-]+${POSITION}?|[A-Za-z]${POSITION})$`);

/** Candidate recognition only. The backend decides whether the reference exists. */
export function fileLinkMatches(text: string): Array<{ text: string; index: number }> {
  const links: Array<{ text: string; index: number }> = [];
  const tokens = /"([^"\r\n]+)"|'([^'\r\n]+)'|`([^`\r\n]+)`|[^\s"'`<>]+/g;
  for (const match of text.matchAll(tokens)) {
    const quoted = match[1] ?? match[2] ?? match[3];
    // Prose wraps references in brackets: `(src/a.ts:49)`.
    const lead = quoted === undefined ? /^[([{]*/.exec(match[0])![0].length : 0;
    const value = quoted ?? match[0].slice(lead).replace(/[.,;:!?)\]}]+$/, '');
    // webLinkMatches owns HTTP links, including their path portions.
    if (!value || /^https?:/i.test(value)) continue;
    // Placeholders (`/dock/...`) and bare punctuation or schemes name nothing.
    // Checked on the raw token: trailing-punctuation stripping would eat the `...`.
    if (/\.\.\.|…/.test(quoted ?? match[0]) || /^[./\\~]*$/.test(value) || /^file:\/*$/i.test(value)) continue;
    if (
      /^(?:file:\/\/|\.{0,2}\/|~\/|[A-Za-z]:[/\\])/.test(value) ||
      /^[\w@.-]+(?:[/\\][\w@. -]+)+(?:[:#]\w+(?::\d+)?)?$/.test(value) ||
      // A one-letter extension (`e.g`) is prose unless a position proves it is code (`main.c:3`).
      BARE_FILE.test(value) ||
      /^[a-z_]+-(?:@[\w.-]+|[0-9a-f]{8}-[0-9a-f-]{27})$/i.test(value)
    ) links.push({ text: value, index: match.index + (quoted === undefined ? lead : 1) });
  }
  return links;
}

/** WebLinksAddon's check: the match must parse as a URL whose origin it starts with. */
function isUrl(text: string): boolean {
  try {
    const url = new URL(text);
    const auth = url.username ? `${url.username}${url.password ? `:${url.password}` : ''}@` : '';
    return text.toLowerCase().startsWith(`${url.protocol}//${auth}${url.host}`.toLowerCase());
  } catch {
    return false;
  }
}

export function webLinkMatches(text: string): Array<{ text: string; index: number }> {
  return [...text.matchAll(new RegExp(URL_REGEX.source, 'g'))]
    .filter((match) => isUrl(match[0]))
    .map((match) => ({ text: match[0], index: match.index }));
}

interface LogicalLine {
  text: string;
  starts: Array<{ x: number; y: number }>;
  ends: Array<{ x: number; y: number }>;
}

/**
 * Whether buffer row `row` (0-based) runs on into the next one. Beyond xterm's own soft
 * wrap, a TUI (Claude Code, Codex) breaks a long URL itself: it fills the row to its right
 * edge and moves the cursor to the next row, which then carries the rest after its
 * indentation. A row filled to the edge (Claude Code's prompt echo keeps one blank margin
 * cell) followed by more text is that break.
 */
function continuesBelow(buffer: IBuffer, row: number): 'soft' | 'hard' | undefined {
  const next = buffer.getLine(row + 1);
  if (!next) return undefined;
  if (next.isWrapped) return 'soft';
  const line = buffer.getLine(row);
  if (!line || !(filled(line, line.length - 1) || filled(line, line.length - 2))) return undefined;
  return next.translateToString(true).trim() ? 'hard' : undefined;
}

function filled(line: IBufferLine, col: number): boolean {
  return Boolean(line.getCell(col)?.getChars().trim());
}

/** The (soft- or hard-) wrapped logical line through buffer row `y` (1-based), with each character's cells. */
function logicalLine(terminal: Terminal, y: number): LogicalLine | undefined {
  const buffer = terminal.buffer.active;
  let start = y - 1;
  let end = start;
  // Bound pathological wrapped output without adding work to the paint path.
  const maxCells = 16384;
  while (start > 0 && continuesBelow(buffer, start - 1) && (end - start + 1) * terminal.cols < maxCells) start--;
  while (continuesBelow(buffer, end) && (end - start + 1) * terminal.cols < maxCells) end++;
  if ((end - start + 1) * terminal.cols >= maxCells) return undefined;

  const line: LogicalLine = { text: '', starts: [], ends: [] };
  for (let row = start; row <= end; row++) {
    const bufferLine = buffer.getLine(row);
    if (!bufferLine) continue;
    // A hard break's indentation and right margin are layout, not part of the text.
    let indent = row > start && continuesBelow(buffer, row - 1) === 'hard';
    const width = row < end && continuesBelow(buffer, row) === 'hard' && !filled(bufferLine, bufferLine.length - 1)
      ? bufferLine.length - 1 : bufferLine.length;
    for (let col = 0; col < width; col++) {
      const cell = bufferLine.getCell(col);
      if (!cell || cell.getWidth() === 0) continue;
      if (indent && !cell.getChars().trim()) continue;
      indent = false;
      // A wide character can wrap one cell early, leaving a non-text spacer.
      if (col === bufferLine.length - 1 && !cell.getChars() && buffer.getLine(row + 1)?.isWrapped &&
          buffer.getLine(row + 1)?.getCell(0)?.getWidth() === 2) continue;
      const chars = cell.getChars() || ' ';
      line.text += chars;
      for (let i = 0; i < chars.length; i++) {
        line.starts.push({ x: col + 1, y: row + 1 });
        line.ends.push({ x: col + cell.getWidth(), y: row + 1 });
      }
    }
  }
  return line;
}

function rangeOf(line: LogicalLine, match: { text: string; index: number }): IBufferRange {
  return { start: line.starts[match.index], end: line.ends[match.index + match.text.length - 1] };
}

function lineLinks(line: LogicalLine): Array<{ text: string; index: number }> {
  return [...fileLinkMatches(line.text), ...webLinkMatches(line.text)];
}

/** File references and web URLs. Maps only the requested logical line; never rescans scrollback on output. */
export class TerminalLinkProvider implements ILinkProvider {
  constructor(private readonly terminal: Terminal, private readonly activate: ActivateLink) {}

  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void {
    const line = logicalLine(this.terminal, y);
    if (!line) return callback(undefined);
    callback(lineLinks(line).map((match) => ({
      text: match.text,
      range: rangeOf(line, match),
      activate: this.activate,
    })));
  }
}

/**
 * xterm activates a link on mouseup for ANY button, so a right-click (or a macOS
 * ctrl-click) would navigate underneath the link menu it is meant to open.
 */
function isPrimaryClick(event: MouseEvent): boolean {
  return event.button === 0 && !(event.ctrlKey && /Mac/i.test(navigator.userAgent));
}

/** Whether a 1-based buffer cell falls inside a (possibly wrapped) link range. */
function rangeContains(range: IBufferRange, x: number, y: number): boolean {
  const afterStart = y > range.start.y || (y === range.start.y && x >= range.start.x);
  const beforeEnd = y < range.end.y || (y === range.end.y && x <= range.end.x);
  return afterStart && beforeEnd;
}

/** The file reference or web URL covering a 1-based buffer cell, straight from the buffer. */
export function linkAtCell(terminal: Terminal, x: number, y: number): string | null {
  const line = logicalLine(terminal, y);
  if (!line) return null;
  const hit = lineLinks(line).find((match) => rangeContains(rangeOf(line, match), x, y));
  return hit?.text ?? null;
}

/** The 1-based buffer cell under a viewport point, from the rendered screen's geometry. */
function cellAtPoint(terminal: Terminal, clientX: number, clientY: number): { x: number; y: number } | null {
  const rect = terminal.element?.querySelector('.xterm-screen')?.getBoundingClientRect();
  if (!rect?.width || !rect.height) return null;
  const x = Math.floor(((clientX - rect.left) / rect.width) * terminal.cols) + 1;
  const row = Math.floor(((clientY - rect.top) / rect.height) * terminal.rows);
  if (x < 1 || x > terminal.cols || row < 0 || row >= terminal.rows) return null;
  return { x, y: row + 1 + terminal.buffer.active.viewportY };
}

/** Call after `terminal.open()`: the right-click menu listens on the terminal's own element. */
export function registerTerminalLinks(terminal: Terminal, handlers: TerminalLinkHandlers): void {
  const activate: ActivateLink = (event, link) => {
    if (isPrimaryClick(event)) handlers.activate(event, link);
  };
  // An OSC 8 link's URI is not in the cells it decorates, so only xterm's hover knows it.
  // Kept past `leave`; the range check below decides whether it is under the pointer.
  let oscLink: { text: string; range: IBufferRange } | null = null;
  terminal.registerLinkProvider(new TerminalLinkProvider(terminal, activate));
  terminal.options.linkHandler = {
    allowNonHttpProtocols: true,
    activate: (event, uri) => {
      if (!isPrimaryClick(event)) return;
      // Keep the existing OSC 8 confirmation, showing the actual destination.
      if (window.confirm(`Do you want to navigate to ${uri}?\n\nWARNING: This link could potentially be dangerous`)) {
        handlers.activate(event, uri);
      }
    },
    hover: (_event, text, range) => {
      oscLink = { text, range };
    },
  };

  // Hit-test the buffer rather than xterm's hover state, which is dropped whenever the
  // terminal refocuses or refits. Capture phase runs before xterm's own right-click
  // handling on its children; the listener goes away with the element.
  terminal.element?.addEventListener('contextmenu', (event) => {
    const cell = cellAtPoint(terminal, event.clientX, event.clientY);
    if (!cell) return;
    const link = linkAtCell(terminal, cell.x, cell.y)
      ?? (oscLink && rangeContains(oscLink.range, cell.x, cell.y) ? oscLink.text : null);
    if (!link) return;
    event.preventDefault();
    event.stopPropagation();
    handlers.openMenu(link, event.clientX, event.clientY);
  }, true);
}
