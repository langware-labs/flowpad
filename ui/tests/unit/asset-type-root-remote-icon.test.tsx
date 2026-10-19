import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '@src/components/ui/tooltip';
import {
  assetTypeRoot,
  buildAssetChild,
} from '@src/components/browseable-tree/adapters/assetTypeRoot';
import type { SearchResult } from '@src/hooks/use-asset-search';
import type { AssetTypeInfo } from '@src/hooks/use-asset-types';

const TYPE: AssetTypeInfo = {
  type_name: 'skill',
  label: 'Skills',
  icon: null,
  creatable: true,
  browseable_by: 'standard',
};

const deps = { indexType: async () => undefined };

function result(remote?: boolean): SearchResult {
  return {
    record_id: '11111111-1111-4111-8111-111111111111',
    record_type: 'skill',
    name: 'Remote kit',
    snippet: null,
    status: '',
    scope: 'user',
    asset_ref: '/tmp/remote-kit',
    created_at: '',
    modified_at: '',
    remote,
  };
}

function renderLeaf(remote?: boolean) {
  const node = buildAssetChild('skill', result(remote), true, 'asset-type:skill');
  return render(<TooltipProvider>{node.icon}</TooltipProvider>);
}

describe('asset type tree entity location icons', () => {
  it.each([
    [true, 'cloud'],
    [false, 'local'],
    [undefined, 'unknown'],
  ] as const)('preserves leaf remote=%s as %s', (remote, expected) => {
    const { container } = renderLeaf(remote);
    const group = container.querySelector('[data-entity-location]');
    expect(group?.getAttribute('data-entity-location')).toBe(expected);
    expect(group?.querySelector('[data-entity-type-icon]')).toBeTruthy();
    expect(group?.firstElementChild).toBe(
      expected === 'unknown'
        ? group?.querySelector('[data-entity-type-icon]')
        : group?.querySelector('[data-location-glyph]'),
    );
  });

  it('keeps the type root registry-only', () => {
    const root = assetTypeRoot(TYPE, deps);
    const { container } = render(<>{root.icon}</>);
    expect(container.querySelector('[data-entity-location]')).toBeNull();
    expect(container.querySelector('svg')).toBeTruthy();
  });
});
