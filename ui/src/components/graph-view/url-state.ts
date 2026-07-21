// React-Router-native state for the shared graph canvas.
//
// WorldView URL shape:
//   /dock[/hub]/worldview/<projection>
//     ?focus=<type-id>&selected=<type-id>&depth=1..12
//     &signal=type|footprint|cost|activity&hide=<sorted,types>&q=<query>

import {
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
import { useCallback, useMemo } from 'react';

const DEFAULT_DEPTH: Record<GraphSurface, number> = {
  dependency: 1,
  worldview: 4,
};

export interface GraphUrlState {
  projection: WorldViewProjectionName | null;
  /** Focused local root key (for example `deployment-<uuid>`). */
  focus: string | null;
  selected: string | null;
  depth: number;
  signal: WorldViewColorMode;
  hidden: ReadonlySet<string>;
  query: string;
}

export type GraphSurface = 'dependency' | 'worldview';

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
  const depth = Number(raw);
  const maximum = surface === 'worldview' ? 12 : 3;
  return Number.isInteger(depth) && depth >= 1 && depth <= maximum ? depth : DEFAULT_DEPTH[surface];
}

function parseSignal(
  raw: string | undefined,
  surface: GraphSurface,
  projection: WorldViewProjectionName | null,
): WorldViewColorMode {
  return surface === 'worldview' && projection === WorldViewProjection.DEPLOYMENT && isWorldViewColorMode(raw)
    ? raw
    : DEFAULT_WORLDVIEW_COLOR_MODE;
}

function parseHidden(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function useGraphUrlState(surface: GraphSurface = 'dependency'): {
  state: GraphUrlState;
  setState: (next: Partial<GraphUrlState>) => void;
} {
  const { currentDock, navigation } = useDockNavigation();

  const state = useMemo<GraphUrlState>(() => {
    const expectedView = surface === 'worldview' ? ViewType.WORLDVIEW : ViewType.GRAPH;
    const activeDock = currentDock?.viewType === expectedView ? currentDock : null;
    const projection =
      surface === 'worldview'
        ? (DockPointer.parseWorldViewProjection(activeDock?.pointer) ??
          (activeDock?.page === PageId.HUB ? WorldViewProjection.WORLD : WorldViewProjection.DEPLOYMENT))
        : null;
    const focus = surface === 'worldview' ? (activeDock?.options?.focus ?? null) : dependencyFocus(activeDock?.pointer);
    return {
      projection,
      focus,
      selected: activeDock?.options?.selected ?? null,
      depth: parseDepth(activeDock?.options?.depth, surface),
      signal: parseSignal(activeDock?.options?.signal ?? activeDock?.options?.color, surface, projection),
      hidden: parseHidden(activeDock?.options?.hide),
      query: activeDock?.options?.q ?? '',
    };
  }, [currentDock, surface]);

  const setState = useCallback(
    (next: Partial<GraphUrlState>) => {
      const merged: GraphUrlState = { ...state, ...next };
      if (surface === 'worldview') {
        navigation.openDock(
          DockPointer.forWorldView(
            merged.projection ?? WorldViewProjection.DEPLOYMENT,
            {
              focus: merged.focus,
              depth: merged.focus && merged.depth !== DEFAULT_DEPTH.worldview ? merged.depth : undefined,
              selected: merged.selected ?? undefined,
              signal: merged.signal,
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
            depth: merged.depth !== DEFAULT_DEPTH.dependency ? merged.depth : undefined,
            selected: merged.selected ?? undefined,
            hidden: [...merged.hidden],
            query: merged.query,
          },
          currentDock?.layout,
        ),
      );
    },
    [currentDock?.layout, currentDock?.page, navigation, state, surface],
  );

  return { state, setState };
}
