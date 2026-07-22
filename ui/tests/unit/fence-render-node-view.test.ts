/**
 * The `code_block` NodeView, mounted on a real `EditorView` in jsdom.
 *
 * Uses a stub renderer rather than mermaid — what's under test is the view
 * contract (fallback, tab strip, error handling, cleanup), not diagram output.
 */

import { createFenceModePlugin } from '@src/components/milkdown-editor/plugins/fence-render/fence-mode';
import { fenceNodeViewConstructor } from '@src/components/milkdown-editor/plugins/fence-render/node-view';
import {
  clearFenceRenderers,
  registerFenceRenderer,
} from '@src/components/milkdown-editor/plugins/fence-render/registry';
import { Schema, type Node as PMNode } from '@milkdown/prose/model';
import { EditorState, TextSelection } from '@milkdown/prose/state';
import { EditorView } from '@milkdown/prose/view';
import { afterEach, describe, expect, it, vi } from 'vitest';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block', toDOM: () => ['p', 0] },
    code_block: {
      content: 'text*',
      group: 'block',
      code: true,
      marks: '',
      attrs: { language: { default: '' } },
      toDOM: (node) => ['pre', { 'data-language': node.attrs.language }, ['code', 0]],
    },
    text: { inline: true },
  },
});

function fence(language: string, code: string): PMNode {
  return schema.nodes.code_block.create({ language }, schema.text(code));
}

/**
 * Docs under test start with a paragraph on purpose. ProseMirror puts the
 * initial selection at the first valid text position, so a doc whose first
 * node is the fence would open with the caret *inside* it — caret precedence
 * would then correctly force the code tab, and any assertion about the default
 * render tab would be testing the fixture rather than the feature.
 */
function para(text: string): PMNode {
  return schema.nodes.paragraph.create(null, schema.text(text));
}

let view: EditorView | null = null;

function mount(...content: PMNode[]): EditorView {
  const place = document.createElement('div');
  document.body.appendChild(place);
  view = new EditorView(place, {
    state: EditorState.create({
      doc: schema.nodes.doc.create(null, content),
      plugins: [createFenceModePlugin()],
    }),
    nodeViews: { code_block: fenceNodeViewConstructor },
  });
  return view;
}

/** Let the NodeView's initial render (scheduled at delay 0) settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

function block(view: EditorView): HTMLElement | null {
  return view.dom.querySelector('[data-testid="fence-render-block"]');
}

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.innerHTML = '';
  clearFenceRenderers();
});

describe('fence NodeView fallback', () => {
  /*
   * The single most important behaviour: a language with no renderer must come
   * out exactly as it did before this plugin existed, or every ordinary code
   * fence in the app regresses.
   */
  it('renders an unregistered language as a plain pre > code', async () => {
    const v = mount(fence('python', 'x = 1'));
    await settle();

    expect(block(v)).toBeNull();
    const pre = v.dom.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre?.querySelector('code')?.textContent).toBe('x = 1');
    expect(pre?.getAttribute('data-language')).toBe('python');
    expect(v.dom.querySelector('.fence-render-tabs')).toBeNull();
  });

  it('renders a bare fence with no info string as a plain pre > code', async () => {
    const v = mount(fence('', 'plain'));
    await settle();
    expect(block(v)).toBeNull();
    expect(v.dom.querySelector('pre code')?.textContent).toBe('plain');
  });
});

describe('fence NodeView with a renderer', () => {
  function stubRenderer(impl?: (code: string, host: HTMLElement) => void | Promise<void>) {
    const render = vi.fn(impl ?? ((code: string, host: HTMLElement) => {
      host.textContent = `rendered:${code}`;
    }));
    registerFenceRenderer({ language: 'stub', tabLabel: 'Preview', render });
    return render;
  }

  it('builds the tab strip, preview and source, starting on the render tab', async () => {
    stubRenderer();
    const v = mount(para('intro'), fence('stub', 'hello'));
    await settle();

    const el = block(v);
    expect(el).not.toBeNull();
    expect(el?.dataset.mode).toBe('render');

    const tabs = [...el!.querySelectorAll('.fence-render-tab')].map((t) => t.textContent);
    expect(tabs).toEqual(['Preview', 'Code']);

    const preview = el!.querySelector('.fence-render-preview') as HTMLElement;
    const source = el!.querySelector('.fence-render-source') as HTMLElement;
    expect(preview.hidden).toBe(false);
    expect(source.hidden).toBe(true);
    expect(preview.textContent).toContain('rendered:hello');
    // contentDOM must exist even while hidden — ProseMirror maps positions through it.
    expect(source.querySelector('code')?.textContent).toBe('hello');
  });

  it('passes the source text and a block id to the renderer', async () => {
    const render = stubRenderer();
    mount(fence('stub', 'graph TD;'));
    await settle();

    expect(render).toHaveBeenCalledOnce();
    const [code, host, ctx] = render.mock.calls[0];
    expect(code).toBe('graph TD;');
    expect(host).toBeInstanceOf(HTMLElement);
    expect(ctx.blockId).toMatch(/^fence-render-\d+$/);
    expect(typeof ctx.commit).toBe('function');
    expect(['light', 'dark']).toContain(ctx.theme);
  });

  it('gives each block a distinct id', async () => {
    const render = stubRenderer();
    mount(fence('stub', 'a'), fence('stub', 'b'));
    await settle();

    const ids = render.mock.calls.map((call) => call[2].blockId);
    expect(new Set(ids).size).toBe(2);
  });

  it('switches to the code tab when the caret enters the block', async () => {
    stubRenderer();
    const v = mount(para('intro'), fence('stub', 'hello'));
    await settle();
    expect(block(v)!.dataset.mode).toBe('render');

    const fencePos = v.state.doc.firstChild!.nodeSize;
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, fencePos + 1)));
    await settle();

    const el = block(v)!;
    expect(el.dataset.mode).toBe('code');
    expect((el.querySelector('.fence-render-source') as HTMLElement).hidden).toBe(false);
    expect((el.querySelector('.fence-render-preview') as HTMLElement).hidden).toBe(true);
    expect(el.querySelector('[data-testid="fence-render-tab-code"]')?.getAttribute('aria-selected')).toBe('true');
  });

  /*
   * A half-typed block must degrade to "stale output + error", never flash to
   * blank — that is the whole reason the renderer contract is throw-based.
   */
  it('keeps the last good output and shows an error chip when a render throws', async () => {
    let shouldFail = false;
    stubRenderer((code, host) => {
      if (shouldFail) throw new Error('Parse error on line 2');
      host.textContent = `rendered:${code}`;
    });

    const v = mount(fence('stub', 'good'));
    await settle();
    expect(block(v)!.textContent).toContain('rendered:good');

    shouldFail = true;
    v.dispatch(v.state.tr.insertText(' broken', 5));
    await new Promise((resolve) => setTimeout(resolve, 250)); // past the render debounce

    const el = block(v)!;
    expect(el.querySelector('[data-testid="fence-render-error"]')?.textContent).toBe('Parse error on line 2');
    expect(el.querySelector('.fence-render-preview')?.textContent).toContain('rendered:good');
  });

  it('recovers once the source is valid again', async () => {
    let shouldFail = true;
    stubRenderer((code, host) => {
      if (shouldFail) throw new Error('nope');
      host.textContent = `rendered:${code}`;
    });

    const v = mount(fence('stub', 'bad'));
    await settle();
    expect(block(v)!.querySelector('[data-testid="fence-render-error"]')).not.toBeNull();

    shouldFail = false;
    v.dispatch(v.state.tr.insertText('!', 4));
    await new Promise((resolve) => setTimeout(resolve, 250));

    const el = block(v)!;
    expect(el.querySelector('.fence-render-preview')?.textContent).toContain('rendered:bad!');
    expect(el.querySelector('[data-testid="fence-render-error"]')).toBeNull();
  });

  /*
   * Regression: `renderedCode` holds the last SUCCESSFUL text, so editing a
   * good block to a bad one and back lands on text that already equals it.
   * Without a failed-attempt flag the re-render is skipped as a no-op and the
   * error chip is stranded on a block whose source is valid again.
   */
  it('clears the error when the source is edited back to its original text', async () => {
    let shouldFail = false;
    stubRenderer((code, host) => {
      if (shouldFail) throw new Error('boom');
      host.textContent = `rendered:${code}`;
    });

    const v = mount(para('intro'), fence('stub', 'good'));
    await settle();
    const fencePos = v.state.doc.firstChild!.nodeSize;

    // Break it.
    shouldFail = true;
    v.dispatch(v.state.tr.insertText('X', fencePos + 5));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(block(v)!.querySelector('[data-testid="fence-render-error"]')).not.toBeNull();

    // Undo the edit: the text is now identical to the last good render.
    shouldFail = false;
    v.dispatch(v.state.tr.delete(fencePos + 5, fencePos + 6));
    await new Promise((resolve) => setTimeout(resolve, 250));

    const el = block(v)!;
    expect(el.querySelector('[data-testid="fence-render-error"]')).toBeNull();
    expect(el.querySelector('.fence-render-preview')?.textContent).toContain('rendered:good');
  });

  describe('commit', () => {
    /** A renderer that commits `next` the first time it is asked to render. */
    function committingRenderer(next: string) {
      registerFenceRenderer({
        language: 'stub',
        tabLabel: 'Preview',
        render: (code, host, ctx) => {
          host.textContent = `rendered:${code}`;
          if (code !== next) ctx.commit(next);
        },
      });
    }

    it('writes the new source into the document', async () => {
      committingRenderer('after');
      const v = mount(para('intro'), fence('stub', 'before'));
      await settle();

      const fencePos = v.state.doc.firstChild!.nodeSize;
      expect(v.state.doc.nodeAt(fencePos)!.textContent).toBe('after');
    });

    /*
     * A fence body never carries a trailing newline — the markdown serializer
     * emits the one before the closing ```. A renderer built on a real
     * serializer (`yaml`'s `toString()` always ends with \n) would otherwise
     * add a blank line inside the block on every commit.
     */
    it('strips a trailing newline from the committed source', async () => {
      committingRenderer('a: 1\nb: 2\n');
      const v = mount(para('intro'), fence('stub', 'a: 1'));
      await settle();

      const fencePos = v.state.doc.firstChild!.nodeSize;
      expect(v.state.doc.nodeAt(fencePos)!.textContent).toBe('a: 1\nb: 2');
    });

    /*
     * The render pane sits outside ProseMirror's editable check, so a renderer
     * could otherwise write to a document the user is only reading.
     */
    it('refuses to write when the host is read-only', async () => {
      committingRenderer('after');
      const place = document.createElement('div');
      document.body.appendChild(place);
      view = new EditorView(place, {
        state: EditorState.create({
          doc: schema.nodes.doc.create(null, [para('intro'), fence('stub', 'before')]),
          plugins: [createFenceModePlugin()],
        }),
        nodeViews: { code_block: fenceNodeViewConstructor },
        editable: () => false,
      });
      await settle();

      const fencePos = view.state.doc.firstChild!.nodeSize;
      expect(view.state.doc.nodeAt(fencePos)!.textContent).toBe('before');
    });

    it('tells the renderer whether the host is editable', async () => {
      const render = vi.fn((code: string, host: HTMLElement) => {
        host.textContent = code;
      });
      registerFenceRenderer({ language: 'stub', tabLabel: 'Preview', render });

      const place = document.createElement('div');
      document.body.appendChild(place);
      view = new EditorView(place, {
        state: EditorState.create({
          doc: schema.nodes.doc.create(null, [para('intro'), fence('stub', 'x')]),
          plugins: [createFenceModePlugin()],
        }),
        nodeViews: { code_block: fenceNodeViewConstructor },
        editable: () => false,
      });
      await settle();

      expect(render.mock.calls[0][2].editable).toBe(false);
    });

    it('is undoable as an ordinary edit', async () => {
      committingRenderer('after');
      const v = mount(para('intro'), fence('stub', 'before'));
      await settle();

      const fencePos = v.state.doc.firstChild!.nodeSize;
      expect(v.state.doc.nodeAt(fencePos)!.textContent).toBe('after');
      // The commit went in as a normal transaction on the document, not as
      // out-of-band state — which is what makes undo/autosave work.
      expect(v.state.doc.nodeAt(fencePos)!.type.name).toBe('code_block');
    });

    /*
     * The host suppresses the re-render its own commit triggers, so a renderer
     * can keep interactive DOM (and the user's focus in it) alive across a
     * write. Without this the field would be torn down mid-edit.
     */
    it('does not re-render the block in response to its own commit', async () => {
      const render = vi.fn((code: string, host: HTMLElement, ctx: { commit: (s: string) => void }) => {
        host.textContent = `rendered:${code}`;
        if (code === 'before') ctx.commit('after');
      });
      registerFenceRenderer({ language: 'stub', tabLabel: 'Preview', render });

      mount(para('intro'), fence('stub', 'before'));
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(render).toHaveBeenCalledOnce();
    });
  });

  it('re-renders when the source changes', async () => {
    const render = stubRenderer();
    const v = mount(fence('stub', 'one'));
    await settle();

    v.dispatch(v.state.tr.insertText('!', 4));
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(render).toHaveBeenCalledTimes(2);
    expect(render.mock.calls[1][0]).toBe('one!');
  });

  it('rebuilds the view when the info string changes to an unregistered language', async () => {
    stubRenderer();
    const v = mount(fence('stub', 'hello'));
    await settle();
    expect(block(v)).not.toBeNull();

    v.dispatch(v.state.tr.setNodeMarkup(0, undefined, { language: 'python' }));
    await settle();

    expect(block(v)).toBeNull();
    expect(v.dom.querySelector('pre code')?.textContent).toBe('hello');
  });
});
