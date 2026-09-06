/**
 * RCA reproduction — the type `shape` must be available SYNCHRONOUSLY.
 *
 * Bug: `useAssetTypes` sources every static type field (icon/creatable/
 * browseable_by) synchronously from the frontend SchemaRegistry
 * (`dataManager.getAllTypeInfos`), but the folder-ness used to be merged from
 * an ASYNC `/assets/types` fetch. On a deep-link the Assets sidebar auto-expands
 * the Skill root on mount — before that fetch resolves — so the skill rows were
 * built as non-folders and cached as non-expandable leaves: no file tree appeared.
 *
 * This test renders the real hook with the fetch left PENDING and asserts that
 * `skill.shape` is already the folder shape on the first synchronous render (it
 * is sourced from the registry).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { dataManager } from '@sdk';
import apiClient from '@sdk/client';

let mode = 'standard';

// Partial mock: only `useViewMode` is steered. The module also exports the
// `ViewMode` enum, which `use-asset-types` reads as `UiViewMode.Vibe` — a
// whole-module replacement drops it and the hook dies on an undefined member.
vi.mock('@src/contexts/view-mode-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@src/contexts/view-mode-context')>()),
  useViewMode: () => mode,
}));

import { useAssetTypes } from '@src/hooks/use-asset-types';

/** Minimal registry TypeInfo carrying only the fields useAssetTypes reads.
 *  the folder shape is the property the fix sources synchronously. */
function skillTypeInfo() {
  return {
    type_name: 'skill',
    browseable_by: 'standard',
    creatable: true,
    icon: 'Sparkles',
    shape: { kind: 'folder', main: 'SKILL.md' },
  };
}

describe('useAssetTypes', () => {
  beforeEach(async () => {
    mode = 'standard';
    await dataManager.loadTypes([skillTypeInfo() as never]);
    // Hold the /assets/types fetch PENDING so the async merge cannot mask the
    // race — the only way shape can be set on first render is the sync
    // registry path (the fix).
    vi.spyOn(apiClient, 'get').mockImplementation(() => new Promise(() => {}) as never);
  });

  // Restore the never-resolving apiClient.get mock so the end-of-file leak-sweep
  // afterAll (../_cleanup) doesn't call into it and hang to a 15s hook timeout.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('carries the skill folder shape on the first render, before the fetch resolves', () => {
    const { result } = renderHook(() => useAssetTypes());

    const skill = result.current.types.find((t) => t.type_name === 'skill');
    expect(skill).toBeDefined();
    expect(skill?.shape?.kind).toBe('folder');
  });

  it('keeps Skill available to an Assets tab in Vibe', () => {
    mode = 'vibe';
    const { result } = renderHook(() => useAssetTypes({ vibeAsStandard: true }));

    expect(result.current.types.some((type) => type.type_name === 'skill')).toBe(true);
  });
});
