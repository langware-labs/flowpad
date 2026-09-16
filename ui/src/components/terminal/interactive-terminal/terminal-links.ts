import { WebLinksAddon } from '@xterm/addon-web-links';
import type { IBufferRange, ILink, ILinkProvider, Terminal } from '@xterm/xterm';

type ActivateLink = (event: MouseEvent, link: string) => void;

/** What a terminal does with its links. */
export interface TerminalLinkHandlers {
  activate: ActivateLink;
  /** Right-click on a link: the terminal has already claimed the event. */
  openMenu: (link: string, clientX: number, clientY: number) => void;
}

/** WebLinksAddon's own default, named so the right-click hit test matches exactly what a click opens. */
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
    // WebLinksAddon owns HTTP links, including their path portions.
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

interface LogicalLine {
  text: string;
  starts: Array<{ x: number; y: number }>;
  ends: Array<{ x: number; y: number }>;
}

/** The wrapped logical line through buffer row `y` (1-based), with each character's cells. */
function logicalLine(terminal: Terminal, y: number): LogicalLine | undefined {
  const buffer = terminal.buffer.active;
  let start = y - 1;
  let end = start;
  // Bound pathological wrapped output without adding work to the paint path.
  const maxCells = 16384;
  while (start > 0 && buffer.getLine(start)?.isWrapped && (end - start + 1) * terminal.cols < maxCells) start--;
  while (buffer.getLine(end + 1)?.isWrapped && (end - start + 1) * terminal.cols < maxCells) end++;
  if ((end - start + 1) * terminal.cols >= maxCells) return undefined;

  const line: LogicalLine = { text: '', starts: [], ends: [] };
  for (let row = start; row <= end; row++) {
    const bufferLine = buffer.getLine(row);
    if (!bufferLine) continue;
    for (let col = 0; col < bufferLine.length; col++) {
      const cell = bufferLine.getCell(col);
      if (!cell || cell.getWidth() === 0) continue;
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

/** Map only the requested logical line; never rescan scrollback on output. */
export class FileLinkProvider implements ILinkProvider {
  constructor(private readonly terminal: Terminal, private readonly activate: ActivateLink) {}

  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void {
    const line = logicalLine(this.terminal, y);
    if (!line) return callback(undefined);
    callback(fileLinkMatches(line.text).map((match) => ({
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
  const urls = [...line.text.matchAll(new RegExp(URL_REGEX.source, 'g'))].map((m) => ({ text: m[0], index: m.index }));
  const hit = [...fileLinkMatches(line.text), ...urls].find((match) => rangeContains(rangeOf(line, match), x, y));
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
  terminal.loadAddon(new WebLinksAddon(activate, { urlRegex: URL_REGEX }));
  terminal.registerLinkProvider(new FileLinkProvider(terminal, activate));
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
