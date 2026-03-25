// ─── Types ───────────────────────────────────────────────────────────────────

export interface SelectionContext {
  text:        string;
  startRow:    number;  // VT absolute (absRow)
  endRow:      number;
  startColumn: number;
  endColumn:   number;
}

export interface ToolbarButton {
  id:      string;
  label:   string;
  enabled: boolean;
  handler: (ctx: SelectionContext) => void;
}

export interface BuiltInDeps {
  onCommentChange: (bufferRow: number, text: string) => void;
}

export type BuiltInToolId = 'selectionComment' | 'copy';

// ─── Built-in tool registry ───────────────────────────────────────────────────

export const BUILTIN_TOOLS: BuiltInToolId[] = ['selectionComment', 'copy'];

// ─── XtermToolbar ─────────────────────────────────────────────────────────────

export class XtermToolbar {
  private _buttons: ToolbarButton[] = [];

  addButton(def: Omit<ToolbarButton, 'handler'>, onclickCode: (ctx: SelectionContext) => void): void {
    this._buttons.push({ ...def, handler: onclickCode });
  }

  loadBuiltIns(deps: BuiltInDeps): void {
    for (const id of BUILTIN_TOOLS) {
      if (id === 'selectionComment') {
        this._buttons.push({
          id:      'selectionComment',
          label:   'Comment',
          enabled: true,
          handler: (ctx) => deps.onCommentChange(ctx.startRow, ctx.text),
        });
      } else if (id === 'copy') {
        this._buttons.push({
          id:      'copy',
          label:   'Copy',
          enabled: true,
          handler: (ctx) => navigator.clipboard.writeText(ctx.text),
        });
      }
    }
  }

  get buttons(): ToolbarButton[] {
    return this._buttons.filter(b => b.enabled);
  }
}
