/**
 * Opening a git share into the receiver's own checkout asks first: the plan
 * (pull / cherry-pick, and any other files it changes) is shown, nothing runs
 * until "Bring it in", which repeats the open in the picked project with
 * `apply: true`. A git-only share has no copy to offer.
 */
import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageAttachment, ReceivePlan } from '@sdk';

vi.mock('@src/navigation', () => ({ useDockNavigation: () => ({ navigation: {} }) }));
vi.mock('@src/navigation/open-display-target', () => ({ openDisplayTarget: vi.fn() }));
vi.mock('@src/notifications', () => ({
  notify: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), dismiss: vi.fn() },
  registerCommand: vi.fn(),
}));

import { SharedOpenPanel } from '@src/components/conversation/asset-review/SharedOpenPanel';

afterEach(cleanup);

const plan = (over: Partial<ReceivePlan> = {}): ReceivePlan => ({
  action: 'cherry_pick',
  commit: 'c1',
  branch: 'main',
  workdir: '/repo',
  commits: ['c1'],
  other_files: [],
  ...over,
});

function attachment(mode: 'git' | 'both', openShared: ReturnType<typeof vi.fn>) {
  return { id: 'ma-1', transfer_mode: mode, effectiveScope: null, openShared } as unknown as MessageAttachment;
}

describe('SharedOpenPanel — yes before writing the receiver checkout', () => {
  it('shows the plan with the other files, and Bring it in repeats the open with apply', async () => {
    const openShared = vi
      .fn()
      .mockResolvedValueOnce({ needs: 'apply', plan: plan({ other_files: ['code.py'] }), project_id: 'p1' })
      .mockResolvedValueOnce({ show: null });
    render(<SharedOpenPanel attachment={attachment('git', openShared)} />);

    fireEvent.click(screen.getByTestId('shared-open'));
    await screen.findByTestId('shared-apply');
    expect(screen.getByTestId('shared-apply-other-files')).toHaveTextContent('code.py');
    expect(openShared).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('shared-apply-confirm'));
    await waitFor(() => expect(openShared).toHaveBeenCalledTimes(2));
    expect(openShared.mock.calls[1][0]).toMatchObject({ projectId: 'p1', apply: true });
  });

  it('Not now runs nothing', async () => {
    const openShared = vi.fn().mockResolvedValueOnce({ needs: 'apply', plan: plan(), project_id: 'p1' });
    render(<SharedOpenPanel attachment={attachment('git', openShared)} />);
    fireEvent.click(screen.getByTestId('shared-open'));
    fireEvent.click(await screen.findByTestId('shared-apply-cancel'));
    expect(screen.queryByTestId('shared-apply')).toBeNull();
    expect(openShared).toHaveBeenCalledTimes(1);
  });

  it('a git-only share with no checkout offers to clone, not a copy it does not carry', async () => {
    const openShared = vi.fn().mockResolvedValueOnce({ needs: 'placement', candidates: [] });
    render(<SharedOpenPanel attachment={attachment('git', openShared)} />);
    fireEvent.click(screen.getByTestId('shared-open'));
    await screen.findByTestId('shared-placement');
    expect(screen.getByTestId('shared-clone')).toBeInTheDocument();
    expect(screen.queryByTestId('shared-copy')).toBeNull();
  });

  it('a share that carries a copy still offers it', async () => {
    const openShared = vi.fn().mockResolvedValueOnce({ needs: 'placement', candidates: [] });
    render(<SharedOpenPanel attachment={attachment('both', openShared)} />);
    fireEvent.click(screen.getByTestId('shared-open'));
    await screen.findByTestId('shared-placement');
    expect(screen.getByTestId('shared-copy')).toBeInTheDocument();
  });
});
