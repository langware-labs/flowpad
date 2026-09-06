/**
 * Task is now a STANDARD-mode browseable folder asset: it must appear in the
 * asset catalog in standard (and advanced/dev), so it shows in the Assets
 * browser + new-from-home via the same shared `browseable_by` gate every other
 * asset uses. Also pins that `task` resolves to the dedicated task asset editor.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { dataManager } from '@sdk';
import { AssetEditor, editorForType } from '@src/navigation/asset-doc-types';
import apiClient from '@sdk/client';

let mode = 'standard';
vi.mock('@src/contexts/view-mode-context', () => ({
  useViewMode: () => mode,
}));

import { useAssetTypes } from '@src/hooks/use-asset-types';

function taskTypeInfo() {
  return {
    type_name: 'task',
    browseable_by: 'standard',
    creatable: true,
    icon: 'CheckSquare',
    main_subdir: 'tasks',
    shape: { kind: 'folder', main: 'task.md' },
  };
}

describe('useAssetTypes — task is a standard-mode asset', () => {
  beforeEach(async () => {
    await dataManager.loadTypes([taskTypeInfo() as never]);
    vi.spyOn(apiClient, 'get').mockImplementation(() => new Promise(() => {}) as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it('shown in standard, advanced and dev', () => {
    for (const m of ['standard', 'advanced', 'dev']) {
      mode = m;
      const { result } = renderHook(() => useAssetTypes());
      expect(
        result.current.types.find((t) => t.type_name === 'task'),
        `task should be browseable in ${m}`,
      ).toBeDefined();
    }
  });

  it('routes to the dedicated task asset editor', () => {
    expect(editorForType('task')).toBe(AssetEditor.TASK);
  });
});
