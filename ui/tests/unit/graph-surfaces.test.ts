// The surface capability table is the SSOT that replaced ~10 scattered
// `surface === 'worldview'` branches in GraphView/url-state. These tests pin
// the contract so a new surface can't silently inherit worldview behavior.
import { describe, expect, it } from 'vitest';
import { SURFACE, type GraphSurface } from '@src/components/graph-view/surfaces';
import { DEFAULT_GRAPH_PRESENTATION, isGraphPresentation } from '@src/types/GraphPresentation';

const SURFACES = Object.keys(SURFACE) as GraphSurface[];

describe('SURFACE capability table', () => {
  it('every surface declares a complete spec', () => {
    expect(SURFACES).toEqual(['dependency', 'worldview', 'subgraph']);
    for (const surface of SURFACES) {
      const spec = SURFACE[surface];
      expect(spec.layout).toMatch(/^(force|circle|dagre)$/);
      expect(typeof spec.presentation).toBe('boolean');
      expect(typeof spec.signals).toBe('boolean');
      expect(spec.depthOptions.length).toBeGreaterThan(0);
      expect(spec.action === 'refresh' || spec.action === 'rebuild').toBe(true);
    }
  });

  it('defaultDepth is selectable and within maxDepth', () => {
    for (const surface of SURFACES) {
      const spec = SURFACE[surface];
      expect(spec.depthOptions).toContain(spec.defaultDepth);
      expect(spec.defaultDepth).toBeLessThanOrEqual(spec.maxDepth);
      expect(Math.max(...spec.depthOptions)).toBeLessThanOrEqual(spec.maxDepth);
    }
  });

  it('presentation (renderer choice) is no longer worldview-only', () => {
    expect(SURFACE.worldview.presentation).toBe(true);
    expect(SURFACE.subgraph.presentation).toBe(true);
  });

  it('signals stay worldview-only — only its payload carries heat', () => {
    expect(SURFACE.worldview.signals).toBe(true);
    expect(SURFACE.subgraph.signals).toBe(false);
    expect(SURFACE.dependency.signals).toBe(false);
  });

  it('derived projections refresh; the stored dep graph rebuilds', () => {
    expect(SURFACE.worldview.action).toBe('refresh');
    expect(SURFACE.subgraph.action).toBe('refresh');
    expect(SURFACE.dependency.action).toBe('rebuild');
  });
});

describe('GraphPresentation', () => {
  it('defaults to sigma and validates the render key', () => {
    expect(DEFAULT_GRAPH_PRESENTATION).toBe('sigma');
    expect(isGraphPresentation('atlas')).toBe(true);
    expect(isGraphPresentation('tree')).toBe(false); // that's a shape, not a renderer
    expect(isGraphPresentation(undefined)).toBe(false);
  });
});
