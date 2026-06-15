/**
 * Component test for `AssetTypeCountBadge` — the sidebar count pill. It is a
 * pure render of the per-type count from `AssetTypeCountsContext` (sourced once
 * from `index-status`); it issues NO network request of its own. These tests
 * drive it in isolation through the context provider — no mocks, no fetch.
 *
 * Regression: the badge previously fired one `/search?limit=1` probe per type
 * row (the N+1 that bloated the asset list page); it now reads from the shared
 * counts map instead.
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import {
  AssetTypeCountBadge,
  AssetTypeCountsContext,
} from '@src/components/browseable-tree/adapters/assetTypeRoot';

function renderBadge(counts: Map<string, number> | null, typeName: string) {
  return render(
    <AssetTypeCountsContext.Provider value={counts}>
      <AssetTypeCountBadge typeName={typeName} />
    </AssetTypeCountsContext.Provider>,
  );
}

describe('AssetTypeCountBadge', () => {
  it('renders the count from context', () => {
    renderBadge(new Map([['skill', 7]]), 'skill');
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('caps display at 999+', () => {
    renderBadge(new Map([['markdown', 1500]]), 'markdown');
    expect(screen.getByText('999+')).toBeInTheDocument();
  });

  it('renders nothing for a zero count', () => {
    const { container } = renderBadge(new Map([['skill', 0]]), 'skill');
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a type missing from the map', () => {
    const { container } = renderBadge(new Map([['markdown', 10]]), 'skill');
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when no provider supplies counts (null context)', () => {
    const { container } = renderBadge(null, 'skill');
    expect(container).toBeEmptyDOMElement();
  });
});
