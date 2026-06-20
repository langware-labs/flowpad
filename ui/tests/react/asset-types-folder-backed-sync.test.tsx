/**
 * RCA reproduction — `folder_backed` must be available SYNCHRONOUSLY.
 *
 * Bug: `useAssetTypes` sources every static type field (icon/creatable/
 * browseable_by) synchronously from the frontend SchemaRegistry
 * (`dataManager.getAllTypeInfos`), but `folder_backed` is merged from an ASYNC
 * `/assets/types` fetch. On a deep-link the Assets sidebar auto-expands the
 * Skill root on mount — before that fetch resolves — so the skill rows are
 * built with `folder_backed=false` and cached as non-expandable leaves: no file
 * tree appears.
 *
 * This test renders the real hook with the fetch left PENDING and asserts that
 * `skill.folder_backed` is already true on the first synchronous render (it is
 * derivable from the registry the fix sources it from). It FAILS today because
 * the value only arrives after the async fetch.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { dataManager } from '@sdk';
import apiClient from '@sdk/client';

// View mode is an external context, not the unit under test — pin it to
// 'standard' so the skill type (browseable_by='standard') passes the filter.
vi.mock('@src/contexts/view-mode-context', () => ({
  useViewMode: () => 'standard',
}));

import { useAssetTypes } from '@src/hooks/use-asset-types';

/** Minimal frontend TypeInfo, folder-backed (the property the fix reads sync). */
function skillTypeInfo() {
  return {
    type_name: 'skill',
    uid_field: 'id',
    index_fields: ['description'],
    defaults: {},
    indexed_by_default: true,
    browseable_by: 'standard',
    creatable: true,
    api_visible: true,
    icon: 'Sparkles',
    parent_type: null,
    locations: ['index'],
    schema_hash: 'test',
    schema: null,
    // The registry already knows skill is folder-backed (asset_ref is a bare
    // folder). The fix exposes this synchronously; today the sidebar instead
    // waits for the async /assets/types fetch.
    folder_backed: true,
  };
}

describe('useAssetTypes — folder_backed is available synchronously', () => {
  beforeEach(async () => {
    await dataManager.loadTypes([skillTypeInfo() as never]);
    // Hold the /assets/types fetch PENDING so the async merge cannot mask the
    // race — the only way folder_backed can be set on first render is the sync
    // registry path (the fix).
    vi.spyOn(apiClient, 'get').mockImplementation(() => new Promise(() => {}) as never);
  });

  it('marks skill folder_backed on the first render, before the fetch resolves', () => {
    const { result } = renderHook(() => useAssetTypes());

    const skill = result.current.types.find((t) => t.type_name === 'skill');
    expect(skill).toBeDefined();
    expect(skill?.folder_backed).toBe(true);
  });
});
