// The tag row under a doc's title: the file header's `tag` and `depends_on` (docs/lw.md).
import { Schema } from '@milkdown/prose/model';
import { EditorState } from '@milkdown/prose/state';
import type { Decoration } from '@milkdown/prose/view';
import { describe, expect, it } from 'vitest';
import { createDocTagsPlugin, docTagsKey, docTagsOf } from '@src/components/milkdown-editor/plugins/doc-tags';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    heading: { group: 'block', content: 'text*', toDOM: () => ['h1', 0] },
    paragraph: { group: 'block', content: 'text*', toDOM: () => ['p', 0] },
    text: {},
  },
});

function rowAfter(first: 'heading' | 'paragraph', fields: Record<string, unknown>) {
  const doc = schema.node('doc', null, [schema.node(first, null, [schema.text('Unified machine access')])]);
  const start = EditorState.create({ doc, plugins: [createDocTagsPlugin()] });
  const state = start.apply(start.tr.setMeta(docTagsKey, docTagsOf(fields)));
  const found = docTagsKey.getState(state)!.decorations.find() as (Decoration & { type: { toDOM: () => HTMLElement } })[];
  return { found, at: found[0]?.from, titleEnd: doc.firstChild!.nodeSize };
}

describe('the tag row under a doc title', () => {
  it('shows the tag and what the doc depends on, right after the title', () => {
    const { found, at, titleEnd } = rowAfter('heading', { tag: 'machine_access', depends_on: ['access_keys'] });
    expect(at).toBe(titleEnd);
    const row = found[0].type.toDOM();
    expect(row.textContent).toBe('Tagmachine_accessDepends onaccess_keys');
    expect(row.querySelector('[data-testid="doc-tag"]')!.textContent).toBe('machine_access');
  });

  it('sits at the top of a doc that has no title', () => {
    expect(rowAfter('paragraph', { tag: 'machine_access' }).at).toBe(0);
  });

  it('draws nothing for a header with neither', () => {
    expect(rowAfter('heading', { title: 'x', tags: ['a'] }).found).toEqual([]);
  });
});
