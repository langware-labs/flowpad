/**
 * The home-page picker lists a project's own assets, so the view mode must not
 * decide which of them exist. Vibe browses no types at all; before `anyMode`
 * the picker sent an empty type list there, the backend fell back to its
 * agent-less default, and a project's agent never showed as a home-page
 * candidate in Vibe while it did in Standard.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { dataManager } from '@sdk';
import apiClient from '@sdk/client';

let mode = 'vibe';
vi.mock('@src/contexts/view-mode-context', () => ({
  useViewMode: () => mode,
  ViewMode: { Vibe: 'vibe', Standard: 'standard', Advanced: 'advanced', Dev: 'dev' },
}));

import { useAssetTypes } from '@src/hooks/use-asset-types';

const names = (types: { type_name: string }[]) => types.map((t) => t.type_name);

describe('useAssetTypes — anyMode', () => {
  beforeEach(async () => {
    await dataManager.loadTypes([
      { type_name: 'agent', browseable_by: 'standard', creatable: true, icon: 'Bot' },
      { type_name: 'helpdesk', browseable_by: 'advanced', creatable: false, icon: 'LifeBuoy' },
    ] as never);
    vi.spyOn(apiClient, 'get').mockImplementation(() => new Promise(() => {}) as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it('Vibe alone browses neither type', () => {
    mode = 'vibe';
    const { result } = renderHook(() => useAssetTypes({ withVaults: false }));
    expect(names(result.current.types)).not.toContain('agent');
  });

  it('lists every browseable type in every mode', () => {
    for (const m of ['vibe', 'standard', 'advanced', 'dev']) {
      mode = m;
      const { result } = renderHook(() => useAssetTypes({ withVaults: false, anyMode: true }));
      expect(names(result.current.types), `in ${m}`).toEqual(expect.arrayContaining(['agent', 'helpdesk']));
    }
  });
});
