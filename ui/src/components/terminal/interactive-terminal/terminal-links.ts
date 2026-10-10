import type { IBuffer, IBufferLine, IBufferRange, ILink, ILinkProvider, Terminal } from '@xterm/xterm';
import { BOX_GLYPHS, ENDS_WHOLE, HAS_RTL, linkMatches, type LinkMatch } from '@src/lib/link-matches';
import { isPrimaryClick, type LinkHandlers } from '@src/components/links/link-events';

type ActivateLink = LinkHandlers['activate'];

interface LogicalLine {
  text: string;
  starts: Array<{ x: number; y: number }>;
  ends: Array<{ x: number; y: number }>;
}

/** What a TUI draws down the side of a box or a quote; layout, never part of the text. */
const BORDER = new RegExp(`^[|${BOX_GLYPHS}]$`);
/** How many blank cells a TUI may keep between a row it filled and the edge (or the box's right border). */
const MAX_MARGIN = 2;

/** The columns `[start, end)` holding a row's own text, and the blank cells after it up to the edge or the right border. */
interface TextSpan {
  start: number;
  end: number;
  margin: number;
}

type Continuation = 'soft' | 'hard' | undefined;

/** What a cell shows; the second half of a wide character counts as shown. */
function shown(line: IBufferLine, col: number): string {
  const cell = line.getCell(col);
  return cell ? cell.getChars().trim() || (cell.getWidth() === 0 ? ' ' : '') : '';
}

/** The column after the last shown cell before `before`. */
function textEnd(line: IBufferLine, before: number): number {
  while (before > 0 && !shown(line, before - 1)) before--;
  return before;
}

function textSpan(line: IBufferLine, cols: number): TextSpan {
  // After a shrink a row can stay longer than the terminal is wide; `cols` is the edge.
  let edge = Math.min(line.length, cols);
  let end = textEnd(line, edge);
  if (end > 1 && BORDER.test(shown(line, end - 1)) && !shown(line, end - 2)) {
    edge = end - 1;
    end = textEnd(line, edge);
  }
  let start = 0;
  while (start < end && (!shown(line, start) || BORDER.test(shown(line, start)))) start++;
  return { start, end, margin: edge - end };
}

/** The unbroken run of shown cells at the end of a row's text (`step` -1) or at its start (`step` 1). */
function edgeWord(line: IBufferLine, span: TextSpan, step: 1 | -1): { cells: number; text: string } {
  const chars: string[] = [];
  for (let col = step === 1 ? span.start : span.end - 1; col >= span.start && col < span.end; col += step) {
    const char = shown(line, col);
    if (!char) break;
    chars.push(char);
  }
  return { cells: chars.length, text: (step === 1 ? chars : chars.reverse()).join('').replace(/ /g, '') };
}

/** A word of prose: letters, then at most the punctuation that ends a clause. */
const PLAIN_WORD = /^(\p{L}+)[.,;:!?]*$/u;
/** Words a sentence goes on with after naming a file, and that no name is likely to end in. */
const RESUMING = new Set('and are but for from has into not now that the then this was when which with'.split(' '));
/** The short ones do end names (`plug|in`, `edit|or`), so they count only after a file extension. */
const RESUMING_SHORT = new Set('as at by if in is it of or so to'.split(' '));

/**
 * Whether `head`, the word starting a row, is prose resuming rather than the rest of `tail`,
 * the word that filled the row above. A reference that ends exactly at the edge leaves the
 * same cells as one cut there, so the text decides: prose resumes with a plain word, and a
 * reference was already whole when it ended in a closed bracket or clause, a position or an
 * id, when the other script takes over, or when the plain word is one a sentence goes on with.
 */
function resumesProse(tail: string, head: string): boolean {
  const last = tail.at(-1) ?? '';
  if (/[\p{L}\p{N}]/u.test(last) && /^\p{L}/u.test(head) && HAS_RTL.test(last) !== HAS_RTL.test(head[0])) return true;
  const word = PLAIN_WORD.exec(head)?.[1];
  if (!word) return false;
  return (
    ENDS_WHOLE.test(tail) ||
    (last === '.' && /^\p{Lu}/u.test(word)) ||
    RESUMING.has(word) ||
    (RESUMING_SHORT.has(word) && /\.[A-Za-z0-9]{2,5}$/.test(tail))
  );
}

/**
 * Whether buffer row `row` (0-based) runs on into the next one. Beyond xterm's own soft
 * wrap, a TUI (Claude Code, Codex) breaks a long URL itself: it fills the row and moves the
 * cursor to the next row, which then carries the rest after its indentation. A wrapper only
 * cuts a word that is longer than a whole row, so that is the test: the word ending this row
 * plus the word starting the next must not fit in one. A row that merely happens to be full
 * (prose ending at the edge, a rule, a reference followed by prose) is a line of its own.
 */
function continuesBelow(buffer: IBuffer, row: number, cols: number): Continuation {
  const line = buffer.getLine(row);
  const next = buffer.getLine(row + 1);
  if (!line || !next) return undefined;
  if (next.isWrapped) return 'soft';
  const above = textSpan(line, cols);
  if (above.margin > MAX_MARGIN) return undefined;
  const below = textSpan(next, cols);
  const tail = edgeWord(line, above, -1);
  const head = edgeWord(next, below, 1);
  if (!head.cells || !/[\p{L}\p{N}]/u.test(tail.text) || resumesProse(tail.text, head.text)) return undefined;
  return tail.cells + head.cells > above.end - below.start ? 'hard' : undefined;
}

/** The (soft- or hard-) wrapped logical line through buffer row `y` (1-based), with each character's cells. */
function logicalLine(terminal: Terminal, y: number): LogicalLine | undefined {
  const buffer = terminal.buffer.active;
  const cols = terminal.cols;
  // Each boundary is judged once: hover asks for the same rows again while walking and while building.
  const judged = new Map<number, Continuation>();
  const below = (row: number): Continuation => {
    if (!judged.has(row)) judged.set(row, continuesBelow(buffer, row, cols));
    return judged.get(row);
  };
  let start = y - 1;
  let end = start;
  // Bound pathological wrapped output without adding work to the paint path.
  const maxCells = 16384;
  while (start > 0 && below(start - 1) && (end - start + 1) * cols < maxCells) start--;
  while (below(end) && (end - start + 1) * cols < maxCells) end++;
  if ((end - start + 1) * cols >= maxCells) return undefined;

  const line: LogicalLine = { text: '', starts: [], ends: [] };
  for (let row = start; row <= end; row++) {
    const bufferLine = buffer.getLine(row);
    if (!bufferLine) continue;
    const width = Math.min(bufferLine.length, cols);
    const hardAbove = row > start && below(row - 1) === 'hard';
    const hardBelow = row < end && below(row) === 'hard';
    // Around a hard break the indentation, a box's borders and the right margin are layout, not text.
    const span = hardAbove || hardBelow ? textSpan(bufferLine, cols) : undefined;
    const to = hardBelow ? span!.end : width;
    for (let col = hardAbove ? span!.start : 0; col < to; col++) {
      const cell = bufferLine.getCell(col);
      if (!cell || cell.getWidth() === 0) continue;
      // A wide character can wrap one cell early, leaving a non-text spacer.
      if (
        col === width - 1 &&
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
