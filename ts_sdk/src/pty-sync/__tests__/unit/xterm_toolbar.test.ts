import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BUILTIN_TOOLS, XtermToolbar } from '../../ui/XtermToolbar.js';
import type { SelectionContext } from '../../ui/XtermToolbar.js';

const mockCtx: SelectionContext = {
  text:        'hello world',
  startRow:    5,
  endRow:      5,
  startColumn: 0,
  endColumn:   11,
};

describe('BUILTIN_TOOLS', () => {
  it('is an array with length 2', () => {
    expect(BUILTIN_TOOLS).toHaveLength(2);
  });

  it('index 0 is selectionComment', () => {
    expect(BUILTIN_TOOLS[0]).toBe('selectionComment');
  });

  it('index 1 is copy', () => {
    expect(BUILTIN_TOOLS[1]).toBe('copy');
  });
});

describe('XtermToolbar', () => {
  let toolbar: XtermToolbar;

  beforeEach(() => {
    toolbar = new XtermToolbar();
  });

  it('addButton + buttons getter returns only enabled buttons', () => {
    toolbar.addButton({ id: 'a', label: 'A', enabled: true  }, () => {});
    toolbar.addButton({ id: 'b', label: 'B', enabled: false }, () => {});
    expect(toolbar.buttons).toHaveLength(1);
    expect(toolbar.buttons[0].id).toBe('a');
  });

  it('disabled button is filtered from buttons', () => {
    toolbar.addButton({ id: 'x', label: 'X', enabled: false }, () => {});
    expect(toolbar.buttons).toHaveLength(0);
  });

  it('custom button via addButton fires handler with ctx', () => {
    const handler = vi.fn();
    toolbar.addButton({ id: 'custom', label: 'Custom', enabled: true }, handler);
    toolbar.buttons[0].handler(mockCtx);
    expect(handler).toHaveBeenCalledWith(mockCtx);
  });

  it('loadBuiltIns loads selectionComment: calls onCommentChange(ctx.startRow, ctx.text)', () => {
    const onCommentChange = vi.fn();
    toolbar.loadBuiltIns({ onCommentChange });
    const btn = toolbar.buttons.find(b => b.id === 'selectionComment')!;
    expect(btn).toBeDefined();
    btn.handler(mockCtx);
    expect(onCommentChange).toHaveBeenCalledWith(mockCtx.startRow, mockCtx.text);
  });

  it('loadBuiltIns loads copy: calls navigator.clipboard.writeText with ctx.text', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, 'navigator', {
      value:        { clipboard: { writeText } },
      writable:     true,
      configurable: true,
    });
    toolbar.loadBuiltIns({ onCommentChange: () => {} });
    const btn = toolbar.buttons.find(b => b.id === 'copy')!;
    expect(btn).toBeDefined();
    btn.handler(mockCtx);
    expect(writeText).toHaveBeenCalledWith(mockCtx.text);
  });
});
