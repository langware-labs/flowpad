// Pointer codecs for the subgraph surface. Deliberately sigma-free (no
// graphEngine import) so loaders and tests can use them without WebGL.
import { ViewType } from '@src/types/ViewType';
import { DockPointer } from '@src/navigation/DockPointer';
import type { SubgraphCodec } from './url-state';

export const TOPIC_KEY_PREFIX = 'topic-';

/** Pointer `graph[/<name>]` ↔ node key `topic-<name>` (names ARE node ids). */
export const topicGraphCodec: SubgraphCodec = {
  viewType: ViewType.TOPIC,
  parseFocus(pointer) {
    const parsed = DockPointer.parseTopicPointer(pointer);
    return parsed?.topic ? `${TOPIC_KEY_PREFIX}${parsed.topic}` : null;
  },
  makePointer(state, carryOptions, layout) {
    const focusTopic = state.focus?.startsWith(TOPIC_KEY_PREFIX)
      ? state.focus.slice(TOPIC_KEY_PREFIX.length)
      : null;
    return DockPointer.forTopicGraph(
      focusTopic,
      {
        depth: state.focus && state.depth !== state.defaultDepth ? state.depth : undefined,
        selected: state.selected ?? undefined,
        render: state.render,
        hidden: state.hidden,
        query: state.query,
        carry: carryOptions,
      },
      layout as never,
    );
  },
};

/**
 * Generic codec for `/dock/subgraph/<projection>[/<focusKey>]` — the zero-new-
 * frontend-code path for future projections. The focus segment IS the node key.
 */
export function genericSubgraphCodec(projection: string): SubgraphCodec {
  return {
    viewType: ViewType.SUBGRAPH,
    parseFocus(pointer) {
      const parsed = DockPointer.parseSubgraphPointer(pointer);
      return parsed && parsed.projection === projection ? parsed.focus : null;
    },
    makePointer(state, carryOptions, layout) {
      return DockPointer.forSubgraph(
        projection,
        state.focus,
        {
          depth: state.focus && state.depth !== state.defaultDepth ? state.depth : undefined,
          selected: state.selected ?? undefined,
          render: state.render,
          hidden: state.hidden,
          query: state.query,
          carry: carryOptions,
        },
        layout as never,
      );
    },
  };
}
