/**
 * Single source of truth for xterm visual config + viewport-size estimates.
 *
 * The xterm constructor in InteractiveTerminal/SidecarShellTerminal reads
 * FONT_FAMILY and FONT_SIZE_PX. The route loader uses estimateCols/Rows to
 * seed the PTY's initial winsize close to the actual rendered grid, so the
 * worker's first paint isn't wrapped at 80 cols on a wide viewport. The
 * InteractiveTerminal still issues an authoritative shell.resize(term.cols,
 * term.rows) once fit.fit() has run — this seed only needs to be in the right
 * ballpark.
 */

export const FONT_FAMILY = '"Cascadia Code", "Fira Code", "JetBrains Mono", Menlo, Monaco, "Courier New", monospace';

/**
 * Click handler for the xterm WebLinksAddon.
 *
 * The addon's default handler opens a blank window first and then assigns
 * location.href. In Electron, setWindowOpenHandler sees `about:blank`
 * (not http/https), denies it, window.open() returns null and the click
 * silently does nothing. Passing the real URL to window.open() lets the
 * Electron handler route it to shell.openExternal, and keeps the same
 * new-tab behavior in a regular browser.
 */
export function openTerminalLink(_event: MouseEvent, uri: string): void {
  window.open(uri, '_blank', 'noopener');
}

export const FONT_SIZE_PX = 14;

/**
 * Restore the character-grid contract for RTL text on Windows.
 *
 * PTY apps that compensate for bidi-less terminals emit Hebrew/Arabic
 * pre-reversed into VISUAL order (Claude Code does this on Windows,
 * matching Windows Terminal/conhost, which paint cells strictly
 * left-to-right). xterm's DOM renderer breaks that contract: row spans are
 * real DOM text, so the browser's Unicode bidi algorithm reorders the RTL
 * run a SECOND time and the words/letters display in reverse reading order.
 * The class added here (styled in styles/xterm.css) forces glyphs to paint
 * in buffer order, matching every native Windows terminal.
 *
 * macOS PTY apps emit logical-order RTL text (native terminals there have
 * real bidi engines), and the browser's single reordering is exactly right
 * — so the override must NOT apply there. Client platform is used as the
 * proxy for the PTY host platform: the desktop provider always spawns PTYs
 * on the machine the UI runs on.
 */
export function applyRtlGridContract(container: HTMLElement): void {
  if (navigator.platform.toLowerCase().includes('win')) {
    container.classList.add('xterm-rtl-grid');
  }
}

/**
 * Honor OSC 52 clipboard WRITES from PTY apps.
 *
 * TUIs that own their text selection (Claude Code's renderer, tmux, neovim)
 * copy by emitting `OSC 52 ; Pc ; <base64> ST` — they never see the host
 * clipboard directly. Every mainstream terminal (Windows Terminal, PyCharm,
 * iTerm2) applies it; xterm.js only does so via an addon, so without this
 * handler a Ctrl+C inside such a TUI is silently dropped and a later Ctrl+V
 * pastes stale clipboard content.
 *
 * Reads (`Pd = ?`) are deliberately NOT answered — responding would let any
 * PTY app exfiltrate the user's clipboard. Returning true still consumes the
 * sequence so it can't leak into the buffer as garbage.
 */
export function registerOsc52ClipboardWrite(term: {
  parser: { registerOscHandler(ident: number, cb: (data: string) => boolean): unknown };
}): void {
  term.parser.registerOscHandler(52, (data: string) => {
    const semi = data.indexOf(';');
    if (semi === -1) return true;
    const payload = data.slice(semi + 1);
    if (payload === '?') return true; // clipboard read — not supported
    try {
      const bytes = Uint8Array.from(atob(payload), (ch) => ch.charCodeAt(0));
      const text = new TextDecoder().decode(bytes);
      if (text) void navigator.clipboard.writeText(text).catch(() => {});
    } catch {
      // malformed base64 — consume and ignore
    }
    return true;
  });
}

// Empirical ratios for monospace at this font size — accurate enough that the
// post-mount fit.fit() rarely changes by more than ±2 cols.
const CELL_WIDTH_RATIO = 0.6; // Cascadia at 14px renders ~8.4 px/char
const LINE_HEIGHT_RATIO = 1.3; // xterm default

// Rough budget for chrome around the terminal pane in /dock/shell:
// left sidebar + column gutters ≈ 200 px, top/bottom bars ≈ 100 px.
// The fit.fit() call after mount is what actually places the terminal —
// this is just a seed so Claude doesn't paint at 80 cols on a 1900px screen.
const RESERVED_X_PX = 200;
const RESERVED_Y_PX = 100;

const cellW = FONT_SIZE_PX * CELL_WIDTH_RATIO;
const cellH = FONT_SIZE_PX * LINE_HEIGHT_RATIO;

/** Best-guess column count for a window of `innerWidth` px. */
export function estimateCols(innerWidth: number): number {
  return Math.max(80, Math.floor((innerWidth - RESERVED_X_PX) / cellW));
}

/** Best-guess row count for a window of `innerHeight` px. */
export function estimateRows(innerHeight: number): number {
  return Math.max(24, Math.floor((innerHeight - RESERVED_Y_PX) / cellH));
}
