// Pointer codecs for the subgraph surface — pure round-trip contracts.
import { describe, expect, it } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';
import { genericSubgraphCodec, topicGraphCodec } from '@src/components/graph-view/codecs';
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

describe('forTopicGraph / parseTopicPointer', () => {
  it('round-trips the focused topic name (dots intact)', () => {
    const ptr = DockPointer.forTopicGraph('qa.e2e.naming');
    expect(ptr.viewType).toBe(ViewType.TOPIC);
    expect(DockPointer.parseTopicPointer(ptr.pointer)).toEqual({ sub: 'graph', topic: 'qa.e2e.naming' });
  });

  it('unfocused form and non-graph pointers', () => {
    expect(DockPointer.parseTopicPointer(DockPointer.forTopicGraph().pointer)).toEqual({
      sub: 'graph',
      topic: null,
    });
    expect(DockPointer.parseTopicPointer('list/whatever')).toBeNull();
    expect(DockPointer.parseTopicPointer(undefined)).toBeNull();
  });

  it('view=tree rides options and survives via carry', () => {
    const ptr = DockPointer.forTopicGraph('flow', { view: 'tree', selected: 'topic-flow.done' });
    expect(ptr.options?.view).toBe('tree');
    expect(ptr.options?.selected).toBe('topic-flow.done');
  });
});

describe('graph presentation pointer (?render=)', () => {
  it('defaults to Sigma and serializes Atlas on the render key', () => {
    const sigma = DockPointer.forWorldView('deployment');
    expect(sigma.options?.render).toBeUndefined();
    const atlas = DockPointer.forWorldView('deployment', { render: 'atlas' });
    expect(atlas.options?.render).toBe('atlas');
  });

  it('render is orthogonal to a surface data-shape key: topic keeps ?view=tree', () => {
    const ptr = DockPointer.forTopicGraph('flow', { view: 'tree', render: 'atlas' });
    expect(ptr.options?.view).toBe('tree'); // shape — owned by the topic surface
    expect(ptr.options?.render).toBe('atlas'); // renderer — owned by the canvas
  });
});

describe('topicGraphCodec', () => {
  it('maps pointer name to node key and back', () => {
    expect(topicGraphCodec.parseFocus('graph/qa.e2e.naming')).toBe('topic-qa.e2e.naming');
    expect(topicGraphCodec.parseFocus('graph')).toBeNull();

    const ptr = topicGraphCodec.makePointer(
      { ...BASE_STATE, focus: 'topic-qa.e2e.naming', selected: 'topic-qa' },
      { view: 'tree' },
    );
    expect(DockPointer.parseTopicPointer(ptr.pointer)?.topic).toBe('qa.e2e.naming');
    expect(ptr.options?.view).toBe('tree'); // carry-through
    expect(ptr.options?.selected).toBe('topic-qa');
  });

  it('non-default depth only serialized while focused', () => {
    const unfocused = topicGraphCodec.makePointer({ ...BASE_STATE, depth: 4 }, {});
    expect(unfocused.options?.depth).toBeUndefined();
    const focused = topicGraphCodec.makePointer({ ...BASE_STATE, focus: 'topic-flow', depth: 4 }, {});
    expect(focused.options?.depth).toBe('4');
  });
});

describe('genericSubgraphCodec', () => {
  it('focus segment is the raw node key, url-encoded round-trip', () => {
    const codec = genericSubgraphCodec('topic');
    const ptr = codec.makePointer({ ...BASE_STATE, focus: 'markdown-abc/def' }, {});
    expect(ptr.viewType).toBe(ViewType.SUBGRAPH);
    expect(codec.parseFocus(ptr.pointer)).toBe('markdown-abc/def');
    // A different projection's pointer yields no focus.
    expect(genericSubgraphCodec('other').parseFocus(ptr.pointer)).toBeNull();
  });

  it('parseSubgraphPointer handles bare projection', () => {
    expect(DockPointer.parseSubgraphPointer('topic')).toEqual({ projection: 'topic', focus: null });
    expect(DockPointer.parseSubgraphPointer(undefined)).toBeNull();
  });
});
