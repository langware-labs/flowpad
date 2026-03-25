import type { Terminal, IDisposable, IMarker, IDecoration } from '@xterm/xterm';
import type { LiveXtermAdapter } from '../adapter/XtermAdapter.js';
import type { XtermToolbar, SelectionContext } from './XtermToolbar.js';

// ─── XTermHarness ─────────────────────────────────────────────────────────────

interface CommentDecoration {
  marker:     IMarker;
  decoration: IDecoration;
}

export class XTermHarness {
  private _toolbar: XtermToolbar | null = null;
  private _echoDisposable: IDisposable | null = null;
  /** absRow → active decoration pair */
  private _commentDecorations = new Map<number, CommentDecoration>();
  private _hoverDecoration: CommentDecoration | null = null;
  onSelectionChange?: (ctx: SelectionContext | null) => void;

  constructor(
    private readonly term: Terminal,
    private readonly adapter: LiveXtermAdapter,
  ) {}

  addSelectionToolbar(toolbar: XtermToolbar): void {
    this._toolbar = toolbar;
    this.term.onSelectionChange(() => this._handleSelectionChange());
  }

  getToolbar(): XtermToolbar | null {
    return this._toolbar;
  }

  /**
   * Wire keyboard input back to the terminal (basic PTY echo).
   * Enter → \r\n, Backspace → erase, everything else passes through.
   * Call dispose() on the returned disposable (or let cleanup handle it via destroy()).
   */
  enableEcho(): IDisposable {
    this._echoDisposable?.dispose();
    this._echoDisposable = this.term.onData(data => {
      if (data === '\r') {
        this.term.write('\r\n');
      } else if (data === '\x7f') {
        // Backspace: move back, overwrite with space, move back again
        this.term.write('\b \b');
      } else {
        this.term.write(data);
      }
    });
    return this._echoDisposable;
  }

  /** Write PTY output directly to the terminal (as if coming from a process). */
  injectOutput(data: string | Uint8Array): void {
    this.term.write(data);
  }

  /**
   * Rebuild all comment decorations to match the current comments map.
   *
   * xterm's registerMarker(cursorYOffset) places a marker at:
   *   buffer.baseY + buffer.cursorY + cursorYOffset
   * which equals the absolute buffer line (0-based from oldest retained row).
   * absRow − evictionOffset gives us that live buffer line index.
   */
  syncCommentDecorations(comments: Map<number, string>, evictionOffset: number): void {
    // Dispose all existing decoration pairs
    for (const { marker, decoration } of this._commentDecorations.values()) {
      decoration.dispose();
      marker.dispose();
    }
    this._commentDecorations.clear();

    if (comments.size === 0) return;

    const buf       = this.term.buffer.active;
    const cursorAbs = buf.baseY + buf.cursorY;   // absolute buffer line of cursor

    for (const absRow of comments.keys()) {
      const liveRow     = absRow - evictionOffset;
      const yOffset     = liveRow - cursorAbs;

      const marker = this.term.registerMarker(yOffset);
      if (!marker || marker.line === -1) continue;

      const decoration = this.term.registerDecoration({
        marker,
        x:      0,
        width:  this.term.cols,  // full row width
      });
      if (!decoration) { marker.dispose(); continue; }

      decoration.onRender(el => {
        // Do NOT override width/height — xterm sets those to correct pixel values.
        // Just apply visual style on top of xterm's already-sized element.
        el.style.background    = 'rgba(240,160,80,0.18)';
        el.style.borderLeft    = '3px solid #f0a050';
        el.style.pointerEvents = 'none';
        el.style.boxSizing     = 'border-box';
        el.title = comments.get(absRow) ?? 'comment';
      });

      this._commentDecorations.set(absRow, { marker, decoration });
    }
  }

  /**
   * Show or clear a hover highlight decoration spanning the full row.
   * Call with absRow to highlight, null to clear.
   */
  setHoverHighlight(absRow: number | null, evictionOffset: number): void {
    if (this._hoverDecoration) {
      this._hoverDecoration.decoration.dispose();
      this._hoverDecoration.marker.dispose();
      this._hoverDecoration = null;
    }
    if (absRow === null) return;

    const buf = this.term.buffer.active;
    const cursorAbs = buf.baseY + buf.cursorY;
    const liveRow = absRow - evictionOffset;
    const yOffset = liveRow - cursorAbs;

    const marker = this.term.registerMarker(yOffset);
    if (!marker || marker.line === -1) return;

    const decoration = this.term.registerDecoration({
      marker,
      x: 0,
      width: this.term.cols,
      layer: 'bottom',
    });
    if (!decoration) { marker.dispose(); return; }

    decoration.onRender(el => {
      el.style.background    = 'rgba(255,255,255,0.06)';
      el.style.pointerEvents = 'none';
      el.style.boxSizing     = 'border-box';
      el.style.display       = 'flex';
      el.style.alignItems    = 'center';
      el.style.justifyContent = 'flex-end';
      el.style.paddingRight  = '4px';
      el.style.fontSize      = '10px';
      el.style.fontFamily    = 'monospace';
      el.style.color         = 'rgba(255,255,255,0.3)';
      el.textContent         = String(absRow);
    });

    this._hoverDecoration = { marker, decoration };
  }

  /** Clear the terminal text selection. */
  clearSelection(): void {
    this.term.clearSelection();
  }

  /** Dispose echo handler and any other managed subscriptions. */
  destroy(): void {
    this._echoDisposable?.dispose();
    this._echoDisposable = null;
    if (this._hoverDecoration) {
      this._hoverDecoration.decoration.dispose();
      this._hoverDecoration.marker.dispose();
      this._hoverDecoration = null;
    }
    for (const { marker, decoration } of this._commentDecorations.values()) {
      decoration.dispose();
      marker.dispose();
    }
    this._commentDecorations.clear();
  }

  private _handleSelectionChange(): void {
    const text = this.term.getSelection();
    if (!text) {
      this.onSelectionChange?.(null);
      return;
    }
    const pos = this.term.getSelectionPosition();
    if (!pos) {
      this.onSelectionChange?.(null);
      return;
    }
    const evOffset = this.adapter.getEvictionOffset();
    // xterm v5 IBufferRange: start/end use 0-based x (column) and y (row)
    const ctx: SelectionContext = {
      text,
      startRow:    pos.start.y + evOffset,
      endRow:      pos.end.y   + evOffset,
      startColumn: pos.start.x,
      endColumn:   pos.end.x,
    };
    this.onSelectionChange?.(ctx);
  }
}
