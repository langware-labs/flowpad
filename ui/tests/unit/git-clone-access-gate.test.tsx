/**
 * The pre-clone access gate in NewProjectFromGitDialog.
 *
 * The point of the gate is that we NEVER start a clone we already know will
 * fail — `/api/v1/git/remote-access` runs the same credential path the clone
 * will, so a "no access" verdict is authoritative. These tests assert the two
 * halves of that contract: a denied probe must not reach `onCreate`, and a
 * passing probe must.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gitMocks = vi.hoisted(() => ({
  hasGitHubRepoAccess: vi.fn(),
}));

vi.mock('@src/utils/gitUtils', () => ({
  hasGitHubRepoAccess: gitMocks.hasGitHubRepoAccess,
}));

// The dialog polls GitHub connect status and subscribes to the WS broadcast on
// open; neither is what's under test here.
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    connectionManager: { on: vi.fn(), off: vi.fn() },
    dataContext: { userTypeId: { type: 'user', id: 'u1' } },
    dataManager: { callAction: vi.fn(() => Promise.resolve({ has_token: false })) },
    oauthService: { connect: vi.fn() },
  };
});

// Repo/branch pickers only render once GitHub is connected (it isn't here), but
// stub them so the module graph stays small.
vi.mock('@src/components/git/RepoPicker', () => ({ RepoPicker: () => null }));
vi.mock('@src/components/git/BranchPicker', () => ({ BranchPicker: () => null }));
vi.mock('@src/components/git/InvitationsStrip', () => ({ InvitationsStrip: () => null }));

import { NewProjectFromGitDialog } from '@src/components/project-selector/NewProjectFromGitDialog';

const REPO_URL ='https://github.com/owner/repo.git';

async function typeUrlAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole('textbox'), REPO_URL);
  await user.click(screen.getByTestId('git-clone-submit'));
}

describe('NewProjectFromGitDialog access gate', () => {
  beforeEach(() => {
    gitMocks.hasGitHubRepoAccess.mockReset();
  });
  afterEach(cleanup);

  // Both verdicts must block the clone; only the wording differs.
  it.each([
    ['the repo is inaccessible', { hasAccess: false, defaultBranch: null }],
    ['the probe could not be answered', null],
  ])('does not clone when %s', async (_label, verdict) => {
    gitMocks.hasGitHubRepoAccess.mockResolvedValue(verdict);
    const onCreate = vi.fn();
    const user = userEvent.setup();

    render(<NewProjectFromGitDialog open onOpenChange={() => {}} onCreate={onCreate} />);
    await typeUrlAndSubmit(user);

    await waitFor(() => expect(screen.getByTestId('git-access-error')).toBeTruthy());
    expect(gitMocks.hasGitHubRepoAccess).toHaveBeenCalledWith(REPO_URL);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('clones once access is confirmed', async () => {
    gitMocks.hasGitHubRepoAccess.mockResolvedValue({ hasAccess: true, defaultBranch: 'main' });
    const onCreate = vi.fn(() => Promise.resolve({ ok: true } as const));
    const user = userEvent.setup();

    render(<NewProjectFromGitDialog open onOpenChange={() => {}} onCreate={onCreate} />);
    await typeUrlAndSubmit(user);

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(REPO_URL, undefined, undefined));
    expect(screen.queryByTestId('git-access-error')).toBeNull();
  });
});
