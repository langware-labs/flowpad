// What each graph surface can do — ONE table instead of `surface === 'x'`
// conditionals scattered through GraphView/url-state.
//
// Adding a surface means adding a row here, not hunting for branches. Adding a
// CAPABILITY means adding a field here plus one read at the place it applies.
import type { GraphLayout } from './graph/loadDepGraph';

export type GraphSurface = 'dependency' | 'worldview' | 'subgraph';

export interface SurfaceSpec {
  /** Layout used when the caller does not override it. */
  layout: GraphLayout;
  /** Offers the renderer toggle (Sigma canvas ⇄ Atlas cards). */
  presentation: boolean;
  /** Offers heat signals (cost/size/activity) — needs worldview-shaped data. */
  signals: boolean;
  /** Local-mode depth choices. */
  depthOptions: number[];
  /** Default local depth, and the max accepted from the URL. */
  defaultDepth: number;
  maxDepth: number;
  /** Top-bar action: refetch a derived projection, or rebuild a stored graph. */
  action: 'refresh' | 'rebuild';
  /** With no focus, report the whole graph as "visible" (vs. 0 = not tracked). */
  countsWhenUnfocused: boolean;
}

export const SURFACE: Record<GraphSurface, SurfaceSpec> = {
  dependency: {
    layout: 'force',
    presentation: false,
    signals: false,
    depthOptions: [1, 2, 3],
    defaultDepth: 1,
    maxDepth: 3,
    action: 'rebuild',
    countsWhenUnfocused: false,
  },
  worldview: {
    layout: 'circle',
    presentation: true,
    signals: true,
    depthOptions: [1, 2, 4, 6, 12],
    defaultDepth: 4,
    maxDepth: 12,
    action: 'refresh',
    countsWhenUnfocused: true,
  },
  subgraph: {
    layout: 'force',
    presentation: true,
    signals: false,
    depthOptions: [1, 2, 3, 4, 6],
    defaultDepth: 2,
    maxDepth: 6,
    action: 'refresh',
    countsWhenUnfocused: true,
  },
};
