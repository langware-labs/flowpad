/**
 * The doc's own tag and the tags it depends on, drawn as one row of chips under
 * the title — the file header's `tag` and `depends_on` (`docs/lw.md`).
 *
 * The header is not part of the editor's document, so the row is a widget: it
 * sits after the first heading (or at the top of a doc that has none) and
 * changes nothing in the text.
 */
import { t } from '@lingui/core/macro';
import type { Node as PMNode } from '@milkdown/prose/model';
import { Plugin, PluginKey, type EditorState } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { $prose } from '@milkdown/utils';

export interface DocTags {
  tag?: string;
  dependsOn: string[];
}

interface DocTagsState {
  tags: DocTags;
  decorations: DecorationSet;
}

export const docTagsKey = new PluginKey<DocTagsState>('flowpad-doc-tags');

const NONE: DocTags = { dependsOn: [] };

/** Header values as they come out of YAML -> what the row shows. Anything that is not a tag is dropped. */
export function docTagsOf(fields: Record<string, unknown>): DocTags {
  const names = (value: unknown): string[] =>
    (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  return { tag: names(fields.tag)[0], dependsOn: names(fields.depends_on) };
}

function row(tags: DocTags): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'doc-tags';
  wrap.dataset.testid = 'doc-tags';
  wrap.contentEditable = 'false';
  const group = (label: string, names: string[], testId: string) => {
    if (!names.length) return;
    const title = document.createElement('span');
    title.className = 'doc-tags-label';
    title.textContent = label;
    wrap.appendChild(title);
    names.forEach((name) => {
      const chip = document.createElement('span');
      chip.className = 'doc-tags-chip';
      chip.dataset.testid = testId;
      chip.textContent = name;
      wrap.appendChild(chip);
    });
  };
  group(t`Tag`, tags.tag ? [tags.tag] : [], 'doc-tag');
  group(t`Depends on`, tags.dependsOn, 'doc-depends-on');
  return wrap;
}

function build(doc: PMNode, tags: DocTags): DecorationSet {
  if (!tags.tag && !tags.dependsOn.length) return DecorationSet.empty;
  const first = doc.firstChild;
  const at = first && first.type.name === 'heading' ? first.nodeSize : 0;
  const key = `doc-tags-${tags.tag ?? ''}-${tags.dependsOn.join(',')}`;
  return DecorationSet.create(doc, [Decoration.widget(at, () => row(tags), { side: -1, key })]);
}

/** Bare plugin, exported for tests on a plain `EditorState`. */
export function createDocTagsPlugin(): Plugin<DocTagsState> {
  return new Plugin<DocTagsState>({
    key: docTagsKey,
    state: {
      init: (_config, state: EditorState) => ({ tags: NONE, decorations: build(state.doc, NONE) }),
      apply: (tr, value, _old, state) => {
        const next = tr.getMeta(docTagsKey) as DocTags | undefined;
        if (!next && !tr.docChanged) return value;
        const tags = next ?? value.tags;
        return { tags, decorations: build(state.doc, tags) };
      },
    },
    props: {
      decorations: (state) => docTagsKey.getState(state)?.decorations ?? null,
    },
  });
}

export const docTagsPlugin = $prose(() => createDocTagsPlugin());
