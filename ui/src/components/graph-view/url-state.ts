// React-Router-native URL state for the built-in GraphView.
// Replaces the skill's app-bridge.ts + urlState.ts pair.
//
// URL shape: /dock/graph/<type>/<id>?depth=N&selected=<key>
//   - pointer "<type>/<id>" → local-mode root (the focused entity)
//   - ?depth=N → local-mode depth (1–3)
//   - ?selected=<key> → highlighted node (defaults to the focused entity)

import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useCallback, useMemo } from 'react';

const DEFAULT_DEPTH = 1;

export interface GraphUrlState {
  /** Local-mode root key (e.g. "markdown-abc"). Null = no focus. */
  local: string | null;
  /** Highlighted node key. Null = none. */
  selected: string | null;
  /** Local-mode depth, 1–3. */
  depth: number;
}

function localKeyFromPointer(pointer: string | undefined): string | null {
  const parsed = DockPointer.parseGraphPointer(pointer);
  return parsed ? `${parsed.type}-${parsed.id}` : null;
}

function parseDepth(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= 3 ? n : DEFAULT_DEPTH;
}

export function useGraphUrlState(): {
  state: GraphUrlState;
  setState: (next: Partial<GraphUrlState>) => void;
} {
  const { currentDock, navigation } = useDockNavigation();

  const state = useMemo<GraphUrlState>(() => {
    const local = localKeyFromPointer(currentDock?.pointer);
    const selected = currentDock?.options?.selected ?? null;
    const depth = parseDepth(currentDock?.options?.depth);
    return { local, selected, depth };
  }, [currentDock?.pointer, currentDock?.options?.selected, currentDock?.options?.depth]);

  const setState = useCallback(
    (next: Partial<GraphUrlState>) => {
      const merged: GraphUrlState = { ...state, ...next };
      // Convert local key (e.g. "markdown-abc") back into a TypeId for the pointer.
      let typeId: { type: string; id: string } | null = null;
      if (merged.local) {
        const idx = merged.local.indexOf('-');
        if (idx > 0) {
          typeId = { type: merged.local.slice(0, idx), id: merged.local.slice(idx + 1) };
        }
      }
      navigation.openDock(
        DockPointer.forGraph(typeId as never, {
          depth: merged.depth !== DEFAULT_DEPTH ? merged.depth : undefined,
          selected: merged.selected ?? undefined,
        }),
      );
    },
    [navigation, state],
  );

  return { state, setState };
}
