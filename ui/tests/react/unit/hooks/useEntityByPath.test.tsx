/**
 * Regression guard: opening an md must ALWAYS (re-)attempt the backend
 * discover — the call that scans the file, creates its doc record, and
 * indexes it — when the doc isn't already resolved.
 *
 * The bug (SAPAK-DEMO-SPEC.md share button): `useEntityByPath` caches a
 * discover NOT_FOUND with `staleTime: Infinity`. A file written to disk
 * AFTER that miss (e.g. by an agent — no WS entity op fires for it) stayed
 * `missing_asset` for the whole session, so the markdown editor never got a
 * chatTarget and the Share button never rendered. The fix drops the cached
 * miss when a consumer mounts for that path, so every open re-runs discover.
 *
 * The poisoned cache state is seeded via the hook's test-only helper instead
 * of a live 404 round-trip — the discover route's miss path deliberately runs
 * the heavy scoped re-index, which is far too slow for this test's budget.
 * Everything else is real: the file is created via the compute-node fs action
 * and the discover round-trip creates + indexes the real markdown record.
 */
import { homedir } from 'os';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TypeId, fsManager } from '@sdk';
import { FSRef } from '@sdk/fs/FSRef';
import { __seedDiscoverMissForTests, useEntityByPath } from '@src/hooks/use-entity-by-path';
import { apiTestSetup, getTestSignupInfo } from '../../../utils/test-utils';

const COMPUTE_NODE_TYPEID = new TypeId('compute_node', '@local');

describe('useEntityByPath — discover re-runs on open (md open ⇒ doc created + indexed)', () => {
  const signupInfo = getTestSignupInfo();
  // Must live under a markdown discovery root (the backend's user_home =
  // Path.home(), same machine) — /tmp classifies to no scope, so discover
  // would 404 there by design.
  const basePath = `${homedir()}/flow-test-md-open-${Date.now()}`;
  const filePath = `${basePath}/OPEN-DISCOVER.md`;
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  let createdEntity: { delete?: () => Promise<boolean> } | null = null;

  beforeAll(async () => {
    await apiTestSetup(signupInfo, 'useEntityByPath-open-discover');
  }, 20000);

  afterAll(async () => {
    try {
      await createdEntity?.delete?.();
    } catch {
      // best-effort — the record is /tmp-rooted and harmless if left behind
    }
    try {
      await fsManager.delete(COMPUTE_NODE_TYPEID, basePath);
    } catch {
      // dir may not exist — ignore
    }
  });

  it('resolves on open despite a session-cached discover miss', async () => {
    // The file exists on disk but has no doc record yet (agent/CLI wrote it —
    // no WS entity op fired), and the session already cached a discover miss
    // for its path from before it existed.
    await fsManager.writeFile(
      COMPUTE_NODE_TYPEID,
      filePath,
      '# Open-discover regression doc\n\nBody.\n',
    );
    __seedDiscoverMissForTests(queryClient, 'markdown', filePath);

    // Opening the md must drop the cached miss and re-run discover, which
    // creates + indexes the doc and resolves it. Without the fix this stays
    // `missing_asset` forever (the seeded NOT_FOUND has staleTime Infinity).
    const fsRef = new FSRef(filePath, COMPUTE_NODE_TYPEID);
    const opened = renderHook(() => useEntityByPath('markdown', fsRef), { wrapper });
    await waitFor(() => expect(opened.result.current.state).toBe('resolved'), {
      timeout: 10000,
    });
    const entity = opened.result.current.entity as {
      asset_ref?: string;
      delete?: () => Promise<boolean>;
    } | null;
    expect(entity?.asset_ref).toContain('OPEN-DISCOVER.md');
    createdEntity = entity;
    opened.unmount();
  }, 25000);
});
