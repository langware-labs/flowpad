import type { IBuffer, IBufferLine, IBufferRange, ILink, ILinkProvider, Terminal } from '@xterm/xterm';
import { linkMatches, type LinkMatch } from '@src/lib/link-matches';
import { isPrimaryClick, type LinkHandlers } from '@src/components/links/link-events';

type ActivateLink = LinkHandlers['activate'];

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
    // A hard break's indentation (or a box's left border) and right margin are layout, not part of the text.
    let indent = row > start && continuesBelow(buffer, row - 1) === 'hard';
    const width =
      row < end && continuesBelow(buffer, row) === 'hard' && !filled(bufferLine, bufferLine.length - 1)
        ? bufferLine.length - 1
        : bufferLine.length;
    for (let col = 0; col < width; col++) {
      const cell = bufferLine.getCell(col);
      if (!cell || cell.getWidth() === 0) continue;
      if (indent && /^[\s│┃║]?$/.test(cell.getChars())) continue;
      indent = false;
      // A wide character can wrap one cell early, leaving a non-text spacer.
      if (
        col === bufferLine.length - 1 &&
        !cell.getChars() &&
        buffer.getLine(row + 1)?.isWrapped &&
        buffer
          .getLine(row + 1)
          ?.getCell(0)
          ?.getWidth() === 2
      )
        continue;
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

function rangeOf(line: LogicalLine, match: LinkMatch): IBufferRange {
  return { start: line.starts[match.index], end: line.ends[match.index + match.text.length - 1] };
}

/** File references and web URLs. Maps only the requested logical line; never rescans scrollback on output. */
export class TerminalLinkProvider implements ILinkProvider {
  constructor(
    private readonly terminal: Terminal,
    private readonly activate: ActivateLink,
  ) {}

  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void {
    const line = logicalLine(this.terminal, y);
    if (!line) return callback(undefined);
    callback(
      linkMatches(line.text).map((match) => ({
        text: match.text,
        range: rangeOf(line, match),
        activate: this.activate,
      })),
    );
  }
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
  const hit = linkMatches(line.text).find((match) => rangeContains(rangeOf(line, match), x, y));
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
export function registerTerminalLinks(terminal: Terminal, handlers: LinkHandlers): void {
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
  terminal.element?.addEventListener(
    'contextmenu',
    (event) => {
      const cell = cellAtPoint(terminal, event.clientX, event.clientY);
      if (!cell) return;
      const link =
        linkAtCell(terminal, cell.x, cell.y) ??
        (oscLink && rangeContains(oscLink.range, cell.x, cell.y) ? oscLink.text : null);
      if (!link) return;
      event.preventDefault();
      event.stopPropagation();
      handlers.openMenu(link, event.clientX, event.clientY);
    },
    true,
  );
}
