/**
 * Phase-3 verification: `<p dir="rtl">` (and `<h* dir="...">`) source markdown
 * round-trips cleanly through the Milkdown editor with the bidi plugins
 * registered. The plain-paragraph default case must serialize byte-identical
 * to the unmodified commonmark output.
 */

import { Editor, rootCtx, defaultValueCtx, serializerCtx, editorViewCtx, commandsCtx } from '@milkdown/core';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { TextSelection } from '@milkdown/prose/state';
import { bidiPlugins, setDirCommand, unsetDirCommand, setAlignCommand, unsetAlignCommand } from '@src/components/milkdown-editor/plugins/bidi';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let host: HTMLDivElement;

async function makeEditor(initial: string): Promise<Editor> {
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, host);
      ctx.set(defaultValueCtx, initial);
    })
    .use(commonmark)
    .use(gfm)
    .use(bidiPlugins)
    .create();
  return editor;
}

function getParagraphAttrs(editor: Editor, index = 0): Record<string, unknown> {
  let attrs: Record<string, unknown> = {};
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const node = view.state.doc.child(index);
    attrs = { type: node.type.name, ...node.attrs };
  });
  return attrs;
}

function serialize(editor: Editor): string {
  let out = '';
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const serializer = ctx.get(serializerCtx);
    out = serializer(view.state.doc);
  });
  return out;
}

describe('bidi round-trip', () => {
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });
  afterEach(() => {
    host.remove();
  });

  it('plain paragraph: default attrs, byte-identical output', async () => {
    const md = 'just a plain English paragraph.\n';
    const editor = await makeEditor(md);
    const attrs = getParagraphAttrs(editor);
    expect(attrs.type).toBe('paragraph');
    expect(attrs.dir).toBeNull();
    expect(attrs.align).toBeNull();
    expect(serialize(editor)).toBe(md);
    await editor.destroy();
  });

  it('blank-line wrapped <p dir="rtl"> → paragraph with dir attr', async () => {
    const md = '<p dir="rtl">\n\nשלום עולם\n\n</p>\n';
    const editor = await makeEditor(md);
    const attrs = getParagraphAttrs(editor);
    expect(attrs.type).toBe('paragraph');
    expect(attrs.dir).toBe('rtl');
    expect(attrs.align).toBeNull();
    await editor.destroy();
  });

  it('round-trip: <p dir="rtl">…</p> survives parse + serialize', async () => {
    const md = '<p dir="rtl">\n\nשלום עולם\n\n</p>\n';
    const editor = await makeEditor(md);
    const out = serialize(editor);
    // Re-parse the output and confirm same shape.
    const editor2 = await makeEditor(out);
    const attrs2 = getParagraphAttrs(editor2);
    expect(attrs2.type).toBe('paragraph');
    expect(attrs2.dir).toBe('rtl');
    await editor.destroy();
    await editor2.destroy();
  });

  // Skipped: heading bidi attrs are intentionally absent until upstream Milkdown
  // fixes the @milkdown/utils extendSchema recursion bug — see
  // ui/src/components/milkdown-editor/plugins/bidi/schema.ts header.
  it.skip('heading with dir="rtl" and text-align: end', async () => {
    const md = '<h2 dir="rtl" style="text-align: end">\n\nכותרת\n\n</h2>\n';
    const editor = await makeEditor(md);
    const attrs = getParagraphAttrs(editor);
    expect(attrs.type).toBe('heading');
    expect(attrs.level).toBe(2);
    expect(attrs.dir).toBe('rtl');
    expect(attrs.align).toBe('end');
    await editor.destroy();
  });

  it('inline form: single-line <p dir="rtl">CONTENT</p>', async () => {
    const md = '<p dir="rtl">שלום</p>\n';
    const editor = await makeEditor(md);
    const attrs = getParagraphAttrs(editor);
    expect(attrs.type).toBe('paragraph');
    expect(attrs.dir).toBe('rtl');
    await editor.destroy();
  });

  it('setDirCommand on selection writes the dir attr; serializer emits the wrapper', async () => {
    const editor = await makeEditor('a plain paragraph.\n');
    // Move the selection into the first paragraph and apply RTL.
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const sel = TextSelection.create(view.state.doc, 1);
      view.dispatch(view.state.tr.setSelection(sel));
      ctx.get(commandsCtx).call(setDirCommand.key, 'rtl');
    });
    expect(getParagraphAttrs(editor)).toMatchObject({ type: 'paragraph', dir: 'rtl' });
    expect(serialize(editor)).toContain('<p dir="rtl">');
    await editor.destroy();
  });

  it('unsetDirCommand clears dir; serializer drops the wrapper', async () => {
    const editor = await makeEditor('<p dir="rtl">\n\nשלום\n\n</p>\n');
    expect(getParagraphAttrs(editor).dir).toBe('rtl');
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
      ctx.get(commandsCtx).call(unsetDirCommand.key);
    });
    expect(getParagraphAttrs(editor).dir).toBeNull();
    expect(serialize(editor)).not.toContain('<p dir');
    await editor.destroy();
  });

  it('setDirCommand skips code blocks', async () => {
    // Markdown with a paragraph followed by a fenced code block; selecting
    // both via setSelection on a large range should only set dir on the
    // paragraph, leaving the code block untouched (code is direction-
    // agnostic and never carries a `dir` attr in our schema).
    const editor = await makeEditor('text para.\n\n```js\nconst x = 1;\n```\n');
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const sel = TextSelection.create(view.state.doc, 1, view.state.doc.content.size - 1);
      view.dispatch(view.state.tr.setSelection(sel));
      ctx.get(commandsCtx).call(setDirCommand.key, 'rtl');
    });
    // First child (paragraph) gets dir; code block has no dir attr to begin with.
    expect(getParagraphAttrs(editor, 0)).toMatchObject({ type: 'paragraph', dir: 'rtl' });
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const cb = view.state.doc.child(1);
      // Code block has no `dir` key in its attrs object after the command —
      // schema didn't add one (only paragraph/heading were extended).
      expect((cb.attrs as Record<string, unknown>).dir).toBeUndefined();
    });
    await editor.destroy();
  });

  it('setAlignCommand writes align attr; serializer emits text-align style', async () => {
    const editor = await makeEditor('a paragraph.\n');
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
      ctx.get(commandsCtx).call(setAlignCommand.key, 'end');
    });
    expect(getParagraphAttrs(editor)).toMatchObject({ type: 'paragraph', align: 'end' });
    const out = serialize(editor);
    expect(out).toContain('style="text-align: end"');
    // Logical value preserved verbatim — no left/right substitution.
    expect(out).not.toContain('text-align: left');
    expect(out).not.toContain('text-align: right');
    await editor.destroy();
  });

  it('unsetAlignCommand clears align; serializer drops the style', async () => {
    const editor = await makeEditor('<p style="text-align: center">\n\ncentered\n\n</p>\n');
    expect(getParagraphAttrs(editor).align).toBe('center');
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
      ctx.get(commandsCtx).call(unsetAlignCommand.key);
    });
    expect(getParagraphAttrs(editor).align).toBeNull();
    expect(serialize(editor)).not.toContain('text-align');
    await editor.destroy();
  });

  it('dir + align combine cleanly: same paragraph carries both', async () => {
    const editor = await makeEditor('mixed.\n');
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
      ctx.get(commandsCtx).call(setDirCommand.key, 'rtl');
      ctx.get(commandsCtx).call(setAlignCommand.key, 'center');
    });
    expect(getParagraphAttrs(editor)).toMatchObject({ dir: 'rtl', align: 'center' });
    const out = serialize(editor);
    expect(out).toContain('<p dir="rtl" style="text-align: center">');
    // Round-trip: re-parse the output and confirm both attrs survive.
    const editor2 = await makeEditor(out);
    expect(getParagraphAttrs(editor2)).toMatchObject({ dir: 'rtl', align: 'center' });
    await editor.destroy();
    await editor2.destroy();
  });

  it('setAlignCommand uses logical values only (never left/right)', async () => {
    // The whole point of phase 5: attribute values are start|end|center|justify.
    // Physical "left"/"right" must never appear in the schema attr or serialized
    // output, regardless of paragraph direction.
    const editor = await makeEditor('text.\n');
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
      ctx.get(commandsCtx).call(setDirCommand.key, 'rtl');
      ctx.get(commandsCtx).call(setAlignCommand.key, 'start');
    });
    // Attr value stays logical; CSS at render time resolves to the right edge
    // because dir=rtl (verified by browser, not by us).
    expect(getParagraphAttrs(editor).align).toBe('start');
    const out = serialize(editor);
    expect(out).toContain('text-align: start');
    await editor.destroy();
  });

  // ── Phase 6: Enter-inheritance ────────────────────────────────────────────

  it('Enter inside an RTL paragraph: new paragraph inherits dir', async () => {
    const editor = await makeEditor('<p dir="rtl">\n\nשלום עולם\n\n</p>\n');
    // Place cursor at end of the RTL paragraph, then simulate Enter.
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const first = view.state.doc.child(0);
      const endOfFirst = 1 + first.content.size; // inside the paragraph, at end
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, endOfFirst)));
      // Dispatch Enter through the keymap directly.
      const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true });
      view.someProp('handleKeyDown', (fn) => fn(view, event));
    });
    // Now there should be two paragraphs, both with dir='rtl'.
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      expect(view.state.doc.childCount).toBe(2);
      expect(view.state.doc.child(0).attrs.dir).toBe('rtl');
      expect(view.state.doc.child(1).attrs.dir).toBe('rtl');
    });
    await editor.destroy();
  });

  // Skipped: relies on heading carrying dir attr — see header above. The
  // enter-inherit handler is gated on the attr existing in the schema, so this
  // scenario cannot work until the heading schema extension is restored.
  it.skip('Enter at end of an RTL heading: new paragraph inherits dir', async () => {
    const editor = await makeEditor('<h2 dir="rtl">\n\nכותרת\n\n</h2>\n');
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const first = view.state.doc.child(0);
      const endOfFirst = 1 + first.content.size;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, endOfFirst)));
      const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true });
      view.someProp('handleKeyDown', (fn) => fn(view, event));
    });
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      expect(view.state.doc.childCount).toBe(2);
      // Heading → Paragraph (Word-like: Enter at end of heading drops to body)
      expect(view.state.doc.child(0).type.name).toBe('heading');
      expect(view.state.doc.child(0).attrs.dir).toBe('rtl');
      expect(view.state.doc.child(1).type.name).toBe('paragraph');
      // …and the new paragraph inherits the dir.
      expect(view.state.doc.child(1).attrs.dir).toBe('rtl');
    });
    await editor.destroy();
  });

  it('Enter inside a plain paragraph: produces a new paragraph with default attrs', async () => {
    // The bidi Enter handler owns the split for paragraph/heading parents (to
    // override the wrong default block-type pick from prosemirror-commands
    // under our extended schema). For plain paragraphs the resulting attrs
    // are still null — same observable behavior as default Enter would have,
    // had it not been broken.
    const editor = await makeEditor('plain English paragraph.\n');
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const first = view.state.doc.child(0);
      const endOfFirst = 1 + first.content.size;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, endOfFirst)));
      const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true });
      view.someProp('handleKeyDown', (fn) => fn(view, event));
    });
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      expect(view.state.doc.childCount).toBe(2);
      expect(view.state.doc.child(0).type.name).toBe('paragraph');
      expect(view.state.doc.child(1).type.name).toBe('paragraph');
      expect(view.state.doc.child(0).attrs.dir).toBeNull();
      expect(view.state.doc.child(1).attrs.dir).toBeNull();
    });
    await editor.destroy();
  });

  it('Enter mid-paragraph inside an RTL block: both halves carry dir', async () => {
    const editor = await makeEditor('<p dir="rtl">\n\nabcde\n\n</p>\n');
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      // Position 3 = inside "abcde" after "ab"
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)));
      const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true });
      view.someProp('handleKeyDown', (fn) => fn(view, event));
    });
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      expect(view.state.doc.childCount).toBe(2);
      expect(view.state.doc.child(0).attrs.dir).toBe('rtl');
      expect(view.state.doc.child(1).attrs.dir).toBe('rtl');
    });
    await editor.destroy();
  });

  it('Enter inside paragraph with align=center: new paragraph inherits align', async () => {
    const editor = await makeEditor('<p style="text-align: center">\n\nhi\n\n</p>\n');
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const first = view.state.doc.child(0);
      const endOfFirst = 1 + first.content.size;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, endOfFirst)));
      const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true });
      view.someProp('handleKeyDown', (fn) => fn(view, event));
    });
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      expect(view.state.doc.childCount).toBe(2);
      expect(view.state.doc.child(1).attrs.align).toBe('center');
    });
    await editor.destroy();
  });

  it('mixed document: only the wrapped paragraph carries attrs', async () => {
    const md = [
      'English paragraph.',
      '',
      '<p dir="rtl">',
      '',
      'פסקה בעברית',
      '',
      '</p>',
      '',
      'Another English paragraph.',
      '',
    ].join('\n');
    const editor = await makeEditor(md);
    expect(getParagraphAttrs(editor, 0)).toMatchObject({ type: 'paragraph', dir: null });
    expect(getParagraphAttrs(editor, 1)).toMatchObject({ type: 'paragraph', dir: 'rtl' });
    expect(getParagraphAttrs(editor, 2)).toMatchObject({ type: 'paragraph', dir: null });
    await editor.destroy();
  });
});
