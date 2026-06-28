/**
 * DynamicWorkflow is an ADVANCED-mode-only browseable asset: it must appear in
 * the asset catalog when the view mode is advanced (or dev) and be hidden in
 * standard. Drives the real `useAssetTypes` hook against the registry — the same
 * cumulative `browseable_by` filter the asset browser uses.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { dataManager } from '@sdk';
import apiClient from '@sdk/client';

let mode = 'standard';
vi.mock('@src/contexts/view-mode-context', () => ({
  useViewMode: () => mode,
}));

import { useAssetTypes } from '@src/hooks/use-asset-types';

function dynamicWorkflowTypeInfo() {
  return {
    type_name: 'dynamic_workflow',
    browseable_by: 'advanced',
    creatable: true,
    icon: 'Boxes',
  };
}

describe('useAssetTypes — dynamic_workflow is advanced-only', () => {
  beforeEach(async () => {
    await dataManager.loadTypes([dynamicWorkflowTypeInfo() as never]);
    vi.spyOn(apiClient, 'get').mockImplementation(() => new Promise(() => {}) as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it('hidden in standard, shown in advanced and dev', () => {
    mode = 'standard';
    const standard = renderHook(() => useAssetTypes());
    expect(standard.result.current.types.find((t) => t.type_name === 'dynamic_workflow')).toBeUndefined();

    mode = 'advanced';
    const advanced = renderHook(() => useAssetTypes());
    expect(advanced.result.current.types.find((t) => t.type_name === 'dynamic_workflow')).toBeDefined();

    mode = 'dev';
    const dev = renderHook(() => useAssetTypes());
    expect(dev.result.current.types.find((t) => t.type_name === 'dynamic_workflow')).toBeDefined();
  });
});
