// React-Router-native state for the shared graph canvas.
//
// WorldView URL shape:
//   /dock[/hub]/worldview/<projection>
//     ?focus=<type-id>&selected=<type-id>&depth=1..12
//     &signal=type|footprint|cost|activity&view=sigma|atlas
//     &hide=<sorted,types>&q=<query>

import {
  Layout,
  PageId,
  TypeId,
  ViewType,
  WorldViewProjection,
  type WorldViewProjection as WorldViewProjectionName,
} from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import {
  DEFAULT_WORLDVIEW_COLOR_MODE,
  isWorldViewColorMode,
  type WorldViewColorMode,
} from '@src/types/WorldViewColorMode';
import {
  DEFAULT_GRAPH_PRESENTATION,
  isGraphPresentation,
  type GraphPresentation,
} from '@src/types/GraphPresentation';
import { SURFACE, type GraphSurface } from './surfaces';
import { useCallback, useMemo } from 'react';

export type { GraphSurface } from './surfaces';

export interface GraphUrlState {
  projection: WorldViewProjectionName | null;
  /** How the canvas draws (`?render=`) — a capability of the surface, not a
   *  property of any single view (see surfaces.ts). */
  presentation: GraphPresentation;
  /** Focused local root key (for example `deployment-<uuid>`). */
  focus: string | null;
  selected: string | null;
  depth: number;
  signal: WorldViewColorMode;
  hidden: ReadonlySet<string>;
  query: string;
}

/**
 * Pointer grammar injection for the generic `subgraph` surface — layer 2 of
 * the graph stack. A thin view type (topic graph, any future subgraph view)
 * supplies a codec instead of this file growing a hardcoded branch per view.
 * Focus lives IN the pointer (dependency pattern); everything else rides the
 * standard query options. `makePointer` must carry through options it does
 * not own (e.g. `view=tree`) so surface toggles survive refocus.
 */
export interface SubgraphCodec {
  /** The dock viewType whose URLs this codec owns. */
  viewType: ViewType;
  /** Pointer → focused node key (null = no focus / whole graph). */
  parseFocus(pointer: string | undefined): string | null;
  /** Rebuild the DockPointer for a state change, preserving foreign options. */
  makePointer(
    state: {
      focus: string | null;
      depth: number;
      defaultDepth: number;
      selected: string | null;
      render: GraphPresentation;
      hidden: readonly string[];
      query: string;
    },
    carryOptions: Record<string, string>,
    layout?: Layout,
  ): DockPointer;
}

function dependencyFocus(pointer: string | undefined): string | null {
  const parsed = DockPointer.parseGraphPointer(pointer);
  return parsed ? `${parsed.type}-${parsed.id}` : null;
}

function typeIdFromNodeKey(key: string | null): TypeId | null {
  if (!key) return null;
  const separator = key.indexOf(TypeId.DELIMITER);
  if (separator <= 0) return null;
  try {
    return new TypeId(key.slice(0, separator), key.slice(separator + TypeId.DELIMITER.length));
  } catch {
    return null;
  }
}

function parseDepth(raw: string | undefined, surface: GraphSurface): number {
  const spec = SURFACE[surface];
  const depth = Number(raw);
  return Number.isInteger(depth) && depth >= 1 && depth <= spec.maxDepth ? depth : spec.defaultDepth;
}

function parseSignal(
  raw: string | undefined,
  surface: GraphSurface,
  projection: WorldViewProjectionName | null,
): WorldViewColorMode {
  // Signals are worldview-heat specific: the capability plus the one
  // projection whose payload actually carries cost/size/activity.
  return SURFACE[surface].signals && projection === WorldViewProjection.DEPLOYMENT && isWorldViewColorMode(raw)
    ? raw
    : DEFAULT_WORLDVIEW_COLOR_MODE;
}

function parsePresentation(raw: string | undefined, surface: GraphSurface): GraphPresentation {
  return SURFACE[surface].presentation && isGraphPresentation(raw) ? raw : DEFAULT_GRAPH_PRESENTATION;
}

function parseHidden(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function useGraphUrlState(
  surface: GraphSurface = 'dependency',
  codec?: SubgraphCodec,
): {
  state: GraphUrlState;
  setState: (next: Partial<GraphUrlState>) => void;
} {
  const { currentDock, navigation } = useDockNavigation();

  const state = useMemo<GraphUrlState>(() => {
    const expectedView =
      surface === 'subgraph' && codec
        ? codec.viewType
        : surface === 'worldview'
          ? ViewType.WORLDVIEW
          : ViewType.GRAPH;
    const activeDock = currentDock?.viewType === expectedView ? currentDock : null;
    const projection =
      surface === 'worldview'
        ? (DockPointer.parseWorldViewProjection(activeDock?.pointer) ??
          (activeDock?.page === PageId.HUB ? WorldViewProjection.WORLD : WorldViewProjection.DEPLOYMENT))
        : null;
    const focus =
      surface === 'subgraph' && codec
        ? codec.parseFocus(activeDock?.pointer)
        : surface === 'worldview'
          ? (activeDock?.options?.focus ?? null)
          : dependencyFocus(activeDock?.pointer);
    return {
      projection,
      presentation: parsePresentation(activeDock?.options?.render, surface),
      focus,
      selected: activeDock?.options?.selected ?? null,
      depth: parseDepth(activeDock?.options?.depth, surface),
      signal: parseSignal(activeDock?.options?.signal ?? activeDock?.options?.color, surface, projection),
      hidden: parseHidden(activeDock?.options?.hide),
      query: activeDock?.options?.q ?? '',
    };
  }, [codec, currentDock, surface]);

  const setState = useCallback(
    (next: Partial<GraphUrlState>) => {
      const merged: GraphUrlState = { ...state, ...next };
      if (surface === 'subgraph' && codec) {
        // Preserve options this layer does not own (a surface's own data-shape
        // keys, e.g. the topic graph's `view=tree`) so they survive refocus.
        // The owned list lives with the writer — see DockPointer.
        const owned = new Set(DockPointer.SUBGRAPH_OPTION_KEYS);
        const carryOptions: Record<string, string> = {};
        const activeOptions =
          currentDock?.viewType === codec.viewType ? (currentDock?.options ?? {}) : {};
        for (const [key, value] of Object.entries(activeOptions)) {
          if (!owned.has(key) && typeof value === 'string') carryOptions[key] = value;
        }
        navigation.openDock(
          codec.makePointer(
            {
              focus: merged.focus,
              depth: merged.depth,
              defaultDepth: SURFACE.subgraph.defaultDepth,
              selected: merged.selected,
              render: merged.presentation,
              hidden: [...merged.hidden],
              query: merged.query,
            },
            carryOptions,
            currentDock?.layout,
          ),
        );
        return;
      }
      if (surface === 'worldview') {
        navigation.openDock(
          DockPointer.forWorldView(
            merged.projection ?? WorldViewProjection.DEPLOYMENT,
            {
              focus: merged.focus,
              depth: merged.focus && merged.depth !== SURFACE.worldview.defaultDepth ? merged.depth : undefined,
              selected: merged.selected ?? undefined,
              signal: merged.signal,
              render: merged.presentation,
              hidden: [...merged.hidden],
              query: merged.query,
            },
            currentDock?.layout,
            currentDock?.page,
          ),
        );
        return;
      }

      navigation.openDock(
        DockPointer.forGraph(
          typeIdFromNodeKey(merged.focus),
          {
            depth: merged.depth !== SURFACE.dependency.defaultDepth ? merged.depth : undefined,
            selected: merged.selected ?? undefined,
            hidden: [...merged.hidden],
            query: merged.query,
          },
          currentDock?.layout,
        ),
      );
    },
    [codec, currentDock?.layout, currentDock?.options, currentDock?.page, currentDock?.viewType, navigation, state, surface],
  );

  return { state, setState };
}
