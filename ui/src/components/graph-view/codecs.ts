// Pointer codecs for the subgraph surface. Deliberately sigma-free (no
// graphEngine import) so loaders and tests can use them without WebGL.
import { ViewType } from '@src/types/ViewType';
import { DockPointer } from '@src/navigation/DockPointer';
import { Layout } from '@sdk';
import type { SubgraphCodec } from './url-state';

export const TAG_KEY_PREFIX = 'tag-';

/** Pointer `graph[/<name>]` ↔ node key `tag-<name>` (names ARE node ids). */
export const tagGraphCodec: SubgraphCodec = {
  viewType: ViewType.TAG,
  parseFocus(pointer) {
    const parsed = DockPointer.parseTagPointer(pointer);
    return parsed?.tag ? `${TAG_KEY_PREFIX}${parsed.tag}` : null;
  },
  makePointer(state, carryOptions, layout) {
    const focusTag = state.focus?.startsWith(TAG_KEY_PREFIX)
      ? state.focus.slice(TAG_KEY_PREFIX.length)
      : null;
    return DockPointer.forTagGraph(
      focusTag,
      {
        depth: state.focus ? state.depth : undefined,
        defaultDepth: state.defaultDepth,
        selected: state.selected ?? undefined,
        render: state.render,
        hidden: state.hidden,
        query: state.query,
        carry: carryOptions,
      },
      layout,
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
          depth: state.focus ? state.depth : undefined,
          defaultDepth: state.defaultDepth,
          selected: state.selected ?? undefined,
          render: state.render,
          hidden: state.hidden,
          query: state.query,
          carry: carryOptions,
        },
        layout,
      );
    },
  };
}
