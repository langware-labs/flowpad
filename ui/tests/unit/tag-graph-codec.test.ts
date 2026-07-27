// Pointer codecs for the subgraph surface — pure round-trip contracts.
import { describe, expect, it } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';
import { genericSubgraphCodec, tagGraphCodec } from '@src/components/graph-view/codecs';
import { ViewType } from '@src/types/ViewType';

const BASE_STATE = {
  focus: null as string | null,
  depth: 2,
  defaultDepth: 2,
  selected: null as string | null,
  render: 'sigma' as const,
  hidden: [] as readonly string[],
  query: '',
};

describe('forTagGraph / parseTagPointer', () => {
  it('round-trips the focused tag name (dots intact)', () => {
    const ptr = DockPointer.forTagGraph('qa.e2e.naming');
    expect(ptr.viewType).toBe(ViewType.TAG);
    expect(DockPointer.parseTagPointer(ptr.pointer)).toEqual({ sub: 'graph', tag: 'qa.e2e.naming' });
  });

  it('unfocused form and non-graph pointers', () => {
    expect(DockPointer.parseTagPointer(DockPointer.forTagGraph().pointer)).toEqual({
      sub: 'graph',
      tag: null,
    });
    expect(DockPointer.parseTagPointer('list/whatever')).toBeNull();
    expect(DockPointer.parseTagPointer(undefined)).toBeNull();
  });

  it('view=tree rides options and survives via carry', () => {
    const ptr = DockPointer.forTagGraph('flow', { view: 'tree', selected: 'tag-flow.done' });
    expect(ptr.options?.view).toBe('tree');
    expect(ptr.options?.selected).toBe('tag-flow.done');
  });
});

describe('graph presentation pointer (?render=)', () => {
  it('defaults to Sigma and serializes Atlas on the render key', () => {
    const sigma = DockPointer.forWorldView('deployment');
    expect(sigma.options?.render).toBeUndefined();
    const atlas = DockPointer.forWorldView('deployment', { render: 'atlas' });
    expect(atlas.options?.render).toBe('atlas');
  });

  it('render is orthogonal to a surface data-shape key: tag keeps ?view=tree', () => {
    const ptr = DockPointer.forTagGraph('flow', { view: 'tree', render: 'atlas' });
    expect(ptr.options?.view).toBe('tree'); // shape — owned by the tag surface
    expect(ptr.options?.render).toBe('atlas'); // renderer — owned by the canvas
  });
});

describe('tagGraphCodec', () => {
  it('maps pointer name to node key and back', () => {
    expect(tagGraphCodec.parseFocus('graph/qa.e2e.naming')).toBe('tag-qa.e2e.naming');
    expect(tagGraphCodec.parseFocus('graph')).toBeNull();

    const ptr = tagGraphCodec.makePointer(
      { ...BASE_STATE, focus: 'tag-qa.e2e.naming', selected: 'tag-qa' },
      { view: 'tree' },
    );
    expect(DockPointer.parseTagPointer(ptr.pointer)?.tag).toBe('qa.e2e.naming');
    expect(ptr.options?.view).toBe('tree'); // carry-through
    expect(ptr.options?.selected).toBe('tag-qa');
  });

  it('non-default depth only serialized while focused', () => {
    const unfocused = tagGraphCodec.makePointer({ ...BASE_STATE, depth: 4 }, {});
    expect(unfocused.options?.depth).toBeUndefined();
    const focused = tagGraphCodec.makePointer({ ...BASE_STATE, focus: 'tag-flow', depth: 4 }, {});
    expect(focused.options?.depth).toBe('4');
  });
});

describe('genericSubgraphCodec', () => {
  it('focus segment is the raw node key, url-encoded round-trip', () => {
    const codec = genericSubgraphCodec('tag');
    const ptr = codec.makePointer({ ...BASE_STATE, focus: 'markdown-abc/def' }, {});
    expect(ptr.viewType).toBe(ViewType.SUBGRAPH);
    expect(codec.parseFocus(ptr.pointer)).toBe('markdown-abc/def');
    // A different projection's pointer yields no focus.
    expect(genericSubgraphCodec('other').parseFocus(ptr.pointer)).toBeNull();
  });

  it('parseSubgraphPointer handles bare projection', () => {
    expect(DockPointer.parseSubgraphPointer('tag')).toEqual({ projection: 'tag', focus: null });
    expect(DockPointer.parseSubgraphPointer(undefined)).toBeNull();
  });
});
