/**
 * Phase 5 — path-only resolve. The client sends a PATH and the backend names
 * the record type: `useEntityByPath` calls `systemTools.resolveByPath(path)`
 * (never a `discoverByPath(type, path)`), keys the entity by the RETURNED
 * type/id, treats the `type` argument as a hint only, maps a 404 (null) to
 * `missing_asset`, and a file-only pointer (a `.py` under the CODE editor)
 * never reaches resolve at all.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveByPath: vi.fn(),
  discoverByPath: vi.fn(),
  getEntityByPath: vi.fn(),
  updateEntityFromJson: vi.fn(),
  getByTypeId: vi.fn(),
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  return {
    ...actual,
    systemTools: {
      ...actual.systemTools,
      resolveByPath: mocks.resolveByPath,
      discoverByPath: mocks.discoverByPath,
    },
    dataManager: {
      ...actual.dataManager,
      getEntityByPath: mocks.getEntityByPath,
      updateEntityFromJson: mocks.updateEntityFromJson,
      getByTypeId: mocks.getByTypeId,
    },
  };
});

vi.mock('@sdk/react/hooks', () => ({
  useEntityOps: () => undefined,
}));

import { FSRef, TypeId } from '@sdk';
import { useEntityByPath } from '@src/hooks/use-entity-by-path';
import { DockPointer } from '@src/navigation/DockPointer';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { AssetEditor, isFileOnlyEditor } from '@src/navigation/asset-doc-types';

const COMPUTE_NODE = new TypeId('compute_node', '@local');
const SKILL_ID = '3f0a1c2e-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const SKILL_DIR = '/Users/me/.claude/skills/decker';

function wrapperFor(queryClient: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getEntityByPath.mockResolvedValue(null);
  mocks.updateEntityFromJson.mockImplementation((row: Record<string, unknown>) => ({ ...row }));
  mocks.getByTypeId.mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useEntityByPath — path-only resolve', () => {
  it('calls resolve with the path only and keys the entity by the returned type/id', async () => {
    mocks.resolveByPath.mockResolvedValue({
      type: 'skill',
      id: SKILL_ID,
      root: SKILL_DIR,
      body: `${SKILL_DIR}/SKILL.md`,
      editor: 'skill',
      entity: { name: 'decker', asset_ref: SKILL_DIR },
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const fsRef = new FSRef(SKILL_DIR, COMPUTE_NODE);

    // The hint is deliberately WRONG: the backend's answer must win.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { result } = renderHook(() => useEntityByPath('markdown', fsRef), {
      wrapper: wrapperFor(queryClient),
    });

    await waitFor(() => expect(result.current.state).toBe('resolved'));

    expect(mocks.resolveByPath).toHaveBeenCalledTimes(1);
    expect(mocks.resolveByPath).toHaveBeenCalledWith(SKILL_DIR);
    expect(mocks.discoverByPath).not.toHaveBeenCalled();

    expect(result.current.resolvedType).toBe('skill');
    expect(result.current.entity).toMatchObject({ type: 'skill', id: SKILL_ID, name: 'decker' });
    // The hydrated row carries the backend's type/id, not the hint.
    expect(mocks.updateEntityFromJson).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'skill', id: SKILL_ID }),
    );
    // The mismatch is reported, not acted on.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("type hint 'markdown'"));
  });

  it('fetches by the returned type/id when the backend classified without hydrating', async () => {
    mocks.resolveByPath.mockResolvedValue({
      type: 'skill',
      id: SKILL_ID,
      root: SKILL_DIR,
      body: null,
      editor: 'skill',
      entity: null,
    });
    mocks.getByTypeId.mockResolvedValue({ type: 'skill', id: SKILL_ID, name: 'decker' });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useEntityByPath(undefined, new FSRef(SKILL_DIR, COMPUTE_NODE)), {
      wrapper: wrapperFor(queryClient),
    });

    await waitFor(() => expect(result.current.state).toBe('resolved'));
    expect(mocks.getByTypeId).toHaveBeenCalledTimes(1);
    expect(String(mocks.getByTypeId.mock.calls[0][0])).toBe(`skill-${SKILL_ID}`);
    expect(mocks.updateEntityFromJson).not.toHaveBeenCalled();
    expect(result.current.resolvedType).toBe('skill');
  });

  it('a 404 (resolve → null) is terminal missing_asset', async () => {
    mocks.resolveByPath.mockResolvedValue(null);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useEntityByPath(null, new FSRef('/Users/me/notes/gone.md', COMPUTE_NODE)), {
      wrapper: wrapperFor(queryClient),
    });

    await waitFor(() => expect(result.current.state).toBe('missing_asset'));
    expect(result.current.entity).toBeNull();
    expect(result.current.resolvedType).toBeNull();
    expect(mocks.resolveByPath).toHaveBeenCalledWith('/Users/me/notes/gone.md');
  });

  it('a non-404 failure is a transient error, not missing_asset', async () => {
    mocks.resolveByPath.mockRejectedValue(Object.assign(new Error('boom'), { response: { status: 500 } }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useEntityByPath(null, new FSRef('/Users/me/notes/x.md', COMPUTE_NODE)), {
      wrapper: wrapperFor(queryClient),
    });

    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.error?.message).toBe('boom');
  });

  it('the exact lookup answers first and resolve stays cold', async () => {
    mocks.getEntityByPath.mockResolvedValue({ type: 'markdown', id: SKILL_ID, asset_ref: '/Users/me/a.md' });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useEntityByPath('markdown', new FSRef('/Users/me/a.md', COMPUTE_NODE)), {
      wrapper: wrapperFor(queryClient),
    });

    await waitFor(() => expect(result.current.state).toBe('resolved'));
    expect(result.current.resolvedType).toBe('markdown');
    expect(mocks.resolveByPath).not.toHaveBeenCalled();
  });
});

describe('a .py opened under the CODE editor never resolves', () => {
  it('routes to the file-only CODE editor and the hook is never enabled', async () => {
    // A type with no editor falls back to the editor the PATH names.
    const dock = DockPointer.forAssetEditor('file', '/Users/me/proj/main.py');
    const ptr = AssetDocPointer.parse(dock.pointer);
    expect(ptr.editor).toBe(AssetEditor.CODE);
    expect(isFileOnlyEditor(ptr.editor!)).toBe(true);

    // AssetEditorRouter passes a null FSRef for file-only editors; a disabled
    // hook must make no network call and report the loading state only.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useEntityByPath(null, null), { wrapper: wrapperFor(queryClient) });
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.resolveByPath).not.toHaveBeenCalled();
    expect(mocks.getEntityByPath).not.toHaveBeenCalled();
    expect(result.current.state).toBe('querying');
    expect(result.current.entity).toBeNull();
  });
});
