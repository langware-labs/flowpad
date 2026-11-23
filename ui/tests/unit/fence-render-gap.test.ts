// The caret between two rendered blocks (fence-gap.ts): where it may sit, and what typing there does.
import { GapCursor } from '@milkdown/prose/gapcursor';
import { Schema, type Node as PMNode } from '@milkdown/prose/model';
import { EditorState } from '@milkdown/prose/state';
import { EditorView } from '@milkdown/prose/view';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFenceGapPlugin, isFenceGap } from '@src/components/milkdown-editor/plugins/fence-render/fence-gap';
import { clearFenceRenderers, registerFenceRenderer } from '@src/components/milkdown-editor/plugins/fence-render/registry';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    // Declared before paragraph, as in the app's schema: it is the block ProseMirror would pick by default.
    heading: { content: 'text*', group: 'block', toDOM: () => ['h1', 0] },
    paragraph: { content: 'text*', group: 'block', toDOM: () => ['p', 0] },
    code_block: { content: 'text*', group: 'block', code: true, attrs: { language: { default: '' } }, toDOM: () => ['pre', ['code', 0]] },
    text: { inline: true },
  },
});
const fence = (language: string, code: string): PMNode => schema.nodes.code_block.create({ language }, schema.text(code));
const para = (text: string): PMNode => schema.nodes.paragraph.create(null, schema.text(text));

let view: EditorView | null = null;
const hosts: HTMLElement[] = [];
function mount(...content: PMNode[]): EditorView {
  view?.destroy();
  const host = document.body.appendChild(document.createElement('div'));
  hosts.push(host);
  view = new EditorView(host, {
    state: EditorState.create({ doc: schema.nodes.doc.create(null, content), plugins: [createFenceGapPlugin()] }),
  });
  return view;
}

beforeEach(() => registerFenceRenderer({ language: 'statements', tabLabel: 'Statements', render: () => {} }));
afterEach(() => {
  view?.destroy();
  for (const host of hosts.splice(0)) host.remove(); // destroy() leaves the mount divs in the body the next file shares
  view = null;
  clearFenceRenderers();
});

describe('the place between rendered blocks', () => {
  it('is between two of them, and between one and the end of the doc, but not next to plain text or plain code', () => {
    const first = fence('statements', 'a');
    const v = mount(para('x'), first, fence('statements', 'b'), fence('python', 'c'));
    const afterPara = 3;
    const between = afterPara + first.nodeSize;
    expect(isFenceGap(v.state, afterPara)).toBe(false); // a caret can already sit in the paragraph
    expect(isFenceGap(v.state, between)).toBe(true);
    expect(isFenceGap(v.state, between + 3)).toBe(false); // a plain code block on the other side
    expect(isFenceGap(mount(fence('statements', 'a')).state, 3)).toBe(true); // the end of the doc
  });

  it('gets a paragraph, not a heading, when text is typed there', () => {
    const first = fence('statements', 'a');
    const v = mount(first, fence('statements', 'b'));
    v.dispatch(v.state.tr.setSelection(new GapCursor(v.state.doc.resolve(first.nodeSize))));
    const handled = v.someProp('handleTextInput', (handle) => handle(v, first.nodeSize, first.nodeSize, 'N', () => v.state.tr));
    expect(handled).toBe(true);
    expect(v.state.doc.child(1).type.name).toBe('paragraph');
    expect(v.state.doc.child(1).textContent).toBe('N');
    expect(v.state.selection.$head.parent).toBe(v.state.doc.child(1)); // the caret is in it, ready for the next key
  });
});
