// React-Router-native URL state for the built-in GraphView.
// Replaces the skill's app-bridge.ts + urlState.ts pair.
//
// URL shape: /dock/{graph|worldview}/<type>/<id>?depth=N&selected=<key>&color=<mode>
//   - pointer "<type>/<id>" → local-mode root (the focused entity)
//   - ?depth=N → local-mode depth (1–3)
//   - ?selected=<key> → highlighted node (defaults to the focused entity)
//   - ?color=<mode> → WorldView color signal (omitted for the default `type`)

import { TypeId, ViewType } from '@sdk';
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
  // Zero means the complete hierarchy. Positive values are explicit local
  // focus depths carried in the URL.
  worldview: 0,
};

export interface GraphUrlState {
  /** Local-mode root key (e.g. "markdown-abc"). Null = no focus. */
  local: string | null;
  /** Highlighted node key. Null = none. */
  selected: string | null;
  /** Local-mode depth. WorldView uses 0 for the complete hierarchy. */
  depth: number;
  /** WorldView node coloring. Dependency graphs always use entity type. */
  color: WorldViewColorMode;
}

export type GraphSurface = 'dependency' | 'worldview';

function localKeyFromPointer(surface: GraphSurface, pointer: string | undefined): string | null {
  const parsed = surface === 'worldview'
    ? DockPointer.parseWorldViewPointer(pointer)
    : DockPointer.parseGraphPointer(pointer);
  return parsed ? `${parsed.type}-${parsed.id}` : null;
}

function typeIdFromNodeKey(key: string | null): TypeId | null {
  if (!key) return null;
  const separator = key.indexOf('-');
  if (separator <= 0) return null;
  try {
    return new TypeId(key.slice(0, separator), key.slice(separator + 1));
  } catch {
    return null;
  }
}

function parseDepth(raw: string | undefined, surface: GraphSurface): number {
  const n = Number(raw);
  const maximum = surface === 'worldview' ? 12 : 3;
  return Number.isInteger(n) && n >= 1 && n <= maximum ? n : DEFAULT_DEPTH[surface];
}

function parseColor(raw: string | undefined, surface: GraphSurface): WorldViewColorMode {
  return surface === 'worldview' && isWorldViewColorMode(raw) ? raw : DEFAULT_WORLDVIEW_COLOR_MODE;
}

export function useGraphUrlState(surface: GraphSurface = 'dependency'): {
  state: GraphUrlState;
  setState: (next: Partial<GraphUrlState>) => void;
} {
  const { currentDock, navigation } = useDockNavigation();

  const state = useMemo<GraphUrlState>(() => {
    const expectedView = surface === 'worldview' ? ViewType.WORLDVIEW : ViewType.GRAPH;
    const local = currentDock?.viewType === expectedView
      ? localKeyFromPointer(surface, currentDock.pointer)
      : null;
    const selected = currentDock?.options?.selected ?? null;
    const depth = parseDepth(currentDock?.options?.depth, surface);
    const color = parseColor(currentDock?.options?.color, surface);
    return { local, selected, depth, color };
  }, [
    currentDock?.viewType,
    currentDock?.pointer,
    currentDock?.options?.selected,
    currentDock?.options?.depth,
    currentDock?.options?.color,
    surface,
  ]);

  const setState = useCallback(
    (next: Partial<GraphUrlState>) => {
      const merged: GraphUrlState = { ...state, ...next };
      const typeId = typeIdFromNodeKey(merged.local);
      const options = {
        depth: merged.depth !== DEFAULT_DEPTH[surface] ? merged.depth : undefined,
        selected: merged.selected ?? undefined,
      };
      navigation.openDock(
        surface === 'worldview'
          ? DockPointer.forWorldView(typeId, {
              ...options,
              color: merged.color === DEFAULT_WORLDVIEW_COLOR_MODE ? undefined : merged.color,
            })
          : DockPointer.forGraph(typeId, options),
      );
    },
    [navigation, state, surface],
  );

  return { state, setState };
}
