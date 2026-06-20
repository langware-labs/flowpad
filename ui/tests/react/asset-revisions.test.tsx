/**
 * Asset revision UI contract tests — verify the git-ops sub-paths and params the
 * per-asset revision feature sends (file-revisions / restore-file), with
 * dataManager.callAction mocked (git-repo.test.ts style).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, renderHook, waitFor, screen, fireEvent } from '@testing-library/react';
import { dataManager, ComputeNode } from '@sdk';
import { useAssetRevisionStatus } from '@src/hooks/use-asset-revision-status';
import { RevisionsPanel } from '@src/components/assets/editor/revisions/RevisionsPanel';
import type { AssetRevision } from '@src/hooks/use-asset-revision-status';

const NODE = '@local';
const WORKDIR = '/home/user/project';
const FILE = '/home/user/project/.claude/skills/slick/SKILL.md';

const REVISIONS: AssetRevision[] = [
  { hash: 'aaaa111', version: 3, message: 'Flowpad: slick v3', date: '2026-06-20T10:00:00Z', author: 't' },
  { hash: 'bbbb222', version: 2, message: 'Flowpad: slick v2', date: '2026-06-20T09:00:00Z', author: 't' },
];

describe('useAssetRevisionStatus', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('calls git-ops/file-revisions with workdir+file and parses the result', async () => {
    const spy = vi
      .spyOn(dataManager, 'callAction')
      .mockResolvedValue({ revisions: REVISIONS, version: 3, unpushed: 2 } as any);

    const { result } = renderHook(() => useAssetRevisionStatus(NODE, WORKDIR, FILE));

    await waitFor(() => expect(result.current.revisions.length).toBe(2));
    expect(result.current.version).toBe(3);
    expect(result.current.unpushed).toBe(2);
    expect(result.current.hasRepo).toBe(true);

    const action = spy.mock.calls[0][0];
    expect(action.name).toBe('git-ops');
    expect(action.subpath).toBe('file-revisions');
    expect(action.queryParameters).toMatchObject({ workdir: WORKDIR, file: FILE });
    expect(action.targetEntity?.type).toBe(ComputeNode.type);
  });

  it('reports no repo when there is no history', async () => {
    vi.spyOn(dataManager, 'callAction').mockResolvedValue({ revisions: [], version: null, unpushed: 0 } as any);
    const { result } = renderHook(() => useAssetRevisionStatus(NODE, WORKDIR, FILE));
    await waitFor(() => expect(result.current.hasRepo).toBe(false));
  });
});

describe('RevisionsPanel restore', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('Restore posts git-ops/restore-file with workdir+file+hash', async () => {
    const spy = vi.spyOn(dataManager, 'callAction').mockResolvedValue({ ok: true, message: 'ok' } as any);
    const onRestored = vi.fn();
    const refresh = vi.fn();

    render(
      <RevisionsPanel
        computeNodeId={NODE}
        workdir={WORKDIR}
        file={FILE}
        revisions={REVISIONS}
        hasRepo
        refresh={refresh}
        onRestored={onRestored}
      />,
    );

    // Restore is only offered on non-current rows (index !== 0).
    const restoreButtons = screen.getAllByTestId('revision-restore');
    expect(restoreButtons.length).toBe(1); // only the v2 (older) row
    fireEvent.click(restoreButtons[0]);

    await waitFor(() => expect(spy).toHaveBeenCalled());
    const action = spy.mock.calls[0][0];
    expect(action.name).toBe('git-ops');
    expect(action.subpath).toBe('restore-file');
    expect(action.method).toBe('POST');
    expect(action.bodyParameters).toMatchObject({ workdir: WORKDIR, file: FILE, hash: 'bbbb222' });
    await waitFor(() => expect(onRestored).toHaveBeenCalled());
  });
});
