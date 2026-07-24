// How a graph is DRAWN — orthogonal to which graph is shown.
//
// `sigma` is the WebGL node/edge canvas; `atlas` is the card-map renderer.
// Both implement `GraphRenderer`, so presentation is a property of the canvas,
// not of any one surface (see graph-view/surfaces.ts `presentation`).
//
// URL: `?render=sigma|atlas`. Deliberately NOT `?view=` — that key belongs to
// a surface's own data shape (e.g. the tag graph's `?view=tree`).
export const GRAPH_PRESENTATIONS = ['sigma', 'atlas'] as const;

export type GraphPresentation = (typeof GRAPH_PRESENTATIONS)[number];

export const DEFAULT_GRAPH_PRESENTATION: GraphPresentation = 'sigma';

export function isGraphPresentation(value: unknown): value is GraphPresentation {
  return typeof value === 'string' && GRAPH_PRESENTATIONS.some((presentation) => presentation === value);
}
