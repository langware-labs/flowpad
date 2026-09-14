import type { Shell } from '@sdk';
import { useDockNavigation } from '@src/navigation';
import { useCallback, useRef, type RefObject } from 'react';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm';

type ActivateLink = (event: MouseEvent, link: string) => void;

/** Candidate recognition only. The backend decides whether the reference exists. */
export function fileLinkMatches(text: string): Array<{ text: string; index: number }> {
  const links: Array<{ text: string; index: number }> = [];
  const tokens = /"([^"\r\n]+)"|'([^'\r\n]+)'|`([^`\r\n]+)`|[^\s"'`<>]+/g;
  for (const match of text.matchAll(tokens)) {
    const quoted = match[1] ?? match[2] ?? match[3];
    const value = quoted ?? match[0].replace(/[.,;!?)\]}]+$/, '');
    // WebLinksAddon owns HTTP links, including their path portions.
    if (/^https?:/i.test(value)) continue;
    if (
      /^(?:file:\/\/|\.{0,2}\/|~\/|[A-Za-z]:[/\\])/.test(value) ||
      /^[\w@.-]+(?:[/\\][\w@. -]+)+(?:[:#]\w+(?::\d+)?)?$/.test(value) ||
      /^[\w@.-]+\.[A-Za-z][\w-]*(?::\d+(?::\d+)?|#L\d+)?$/.test(value) ||
      /^[a-z_]+-(?:@[\w.-]+|[0-9a-f]{8}-[0-9a-f-]{27})$/i.test(value)
    ) links.push({ text: value, index: match.index + (quoted === undefined ? 0 : 1) });
  }
  return links;
}

/** Map only the requested logical line; never rescan scrollback on output. */
export class FileLinkProvider implements ILinkProvider {
  constructor(private readonly terminal: Terminal, private readonly activate: ActivateLink) {}

  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void {
    const { terminal } = this;
    const buffer = terminal.buffer.active;
    let start = y - 1;
    let end = start;
    // Bound pathological wrapped output without adding work to the paint path.
    const maxCells = 16384;
    while (start > 0 && buffer.getLine(start)?.isWrapped && (end - start + 1) * terminal.cols < maxCells) start--;
    while (buffer.getLine(end + 1)?.isWrapped && (end - start + 1) * terminal.cols < maxCells) end++;
    if ((end - start + 1) * terminal.cols >= maxCells) return callback(undefined);

    let text = '';
    const starts: Array<{ x: number; y: number }> = [];
    const ends: Array<{ x: number; y: number }> = [];
    for (let row = start; row <= end; row++) {
      const line = buffer.getLine(row);
      if (!line) continue;
      for (let col = 0; col < line.length; col++) {
        const cell = line.getCell(col);
        if (!cell || cell.getWidth() === 0) continue;
        // A wide character can wrap one cell early, leaving a non-text spacer.
        if (col === line.length - 1 && !cell.getChars() && buffer.getLine(row + 1)?.isWrapped &&
            buffer.getLine(row + 1)?.getCell(0)?.getWidth() === 2) continue;
        const chars = cell.getChars() || ' ';
        text += chars;
        for (let i = 0; i < chars.length; i++) {
          starts.push({ x: col + 1, y: row + 1 });
          ends.push({ x: col + cell.getWidth(), y: row + 1 });
        }
      }
    }
    callback(fileLinkMatches(text).map((match) => ({
      text: match.text,
      range: { start: starts[match.index], end: ends[match.index + match.text.length - 1] },
      activate: this.activate,
    })));
  }
}

/** Read the current navigation/source without retaining a terminal render's closure. */
export function useTerminalLinkHandler(source: RefObject<Shell | null>): ActivateLink {
  const { navigation } = useDockNavigation();
  const navRef = useRef(navigation);
  navRef.current = navigation;
  return useCallback((_event: MouseEvent, link: string) => {
    void navRef.current.openLink(link, source.current);
  }, [source]);
}

export function registerTerminalLinks(terminal: Terminal, activate: ActivateLink): void {
  terminal.loadAddon(new WebLinksAddon(activate));
  terminal.registerLinkProvider(new FileLinkProvider(terminal, activate));
  terminal.options.linkHandler = {
    allowNonHttpProtocols: true,
    activate: (event, uri) => {
      // Keep the existing OSC 8 confirmation, showing the actual destination.
      if (window.confirm(`Do you want to navigate to ${uri}?\n\nWARNING: This link could potentially be dangerous`)) {
        activate(event, uri);
      }
    },
  };
}
