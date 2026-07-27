// Theme-aware color palette for the sigma renderer.
// Sigma draws to canvas, so CSS variables can't reach it — these are read at
// init time and re-applied via Sigma.setSetting / refresh when the host theme
// flips (see graphEngine.setTheme()).

export type Theme = 'light' | 'dark';

export type EdgeKind = 'child' | 'deployed_as' | 'context_shared' | 'context_private' | 'parent';

export interface GraphPalette {
  labelColor: string;
  labelBackground: string;
  hoverLabelBackground: string;
  defaultNodeColor: string;
  defaultEdgeColor: string;
  edgeKindColor: Record<EdgeKind, string>;
  hoverEdgeColor: string;
  hoverEdgeSize: number;
  dimEdgeColor: string;
  hoverNodeBorder: string;
}

const DARK: GraphPalette = {
  labelColor: '#cbd5e1',
  labelBackground: 'rgba(2, 6, 23, 0.78)',
  hoverLabelBackground: 'rgba(15, 23, 42, 0.97)',
  defaultNodeColor: '#94a3b8',
  defaultEdgeColor: 'rgba(255,255,255,0.10)',
  edgeKindColor: {
    child: 'rgba(99, 102, 241, 0.55)',
    deployed_as: 'rgba(34, 211, 238, 0.72)',
    context_shared: 'rgba(16, 185, 129, 0.65)',
    context_private: 'rgba(245, 158, 11, 0.75)',
    parent: 'rgba(167, 139, 250, 0.55)',
  },
  hoverEdgeColor: 'rgba(255,255,255,0.55)',
  hoverEdgeSize: 1.4,
  dimEdgeColor: 'rgba(255,255,255,0.04)',
  hoverNodeBorder: '#f8fafc',
};

const LIGHT: GraphPalette = {
  labelColor: '#1e293b',
  labelBackground: 'rgba(248, 250, 252, 0.86)',
  hoverLabelBackground: 'rgba(255, 255, 255, 0.98)',
  defaultNodeColor: '#64748b',
  defaultEdgeColor: 'rgba(15,23,42,0.14)',
  edgeKindColor: {
    child: 'rgba(67, 56, 202, 0.55)',
    deployed_as: 'rgba(8, 145, 178, 0.68)',
    context_shared: 'rgba(5, 150, 105, 0.65)',
    context_private: 'rgba(180, 83, 9, 0.75)',
    parent: 'rgba(124, 58, 237, 0.55)',
  },
  hoverEdgeColor: 'rgba(15,23,42,0.6)',
  hoverEdgeSize: 1.4,
  dimEdgeColor: 'rgba(15,23,42,0.05)',
  hoverNodeBorder: '#0f172a',
};

export function paletteForTheme(theme: Theme): GraphPalette {
  return theme === 'light' ? LIGHT : DARK;
}
