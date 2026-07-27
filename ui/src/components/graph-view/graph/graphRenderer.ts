import type { NodeData, SearchResult } from './graphModel';
import type { Theme } from './themeColors';
import type { WorldViewColorMode } from '@src/types/WorldViewColorMode';

export type LocalState = { root: string | null; depth: number; visibleCount: number };

export interface GraphRenderer {
  init(container: HTMLElement): void;
  destroy(): void;
  setTheme(theme: Theme): void;
  setColorMode(mode: WorldViewColorMode): void;
  setHiddenTypes(types: ReadonlySet<string>): void;
  setLocalMode(root: string | null, depth?: number): LocalState;
  selectNode(key: string | null): void;
  getNodeData(key: string): NodeData | null;
  searchNodes(query: string): SearchResult[];
  onNodeSelect(listener: (key: string | null) => void): () => void;
  onNodeDoubleClick(listener: (key: string) => void): () => void;
}
