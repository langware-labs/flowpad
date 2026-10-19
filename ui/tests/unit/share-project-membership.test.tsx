import { act, renderHook, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@sdk';
import { projectNonMembers, useShareProjectMembership } from '@src/hooks/use-share-project-membership';
const mocks = vi.hoisted(() => ({ roster: vi.fn(), roles: vi.fn(), invite: vi.fn() }));
vi.mock('@sdk', () => ({ membershipService: { fetchMembershipsStrict: mocks.roster, fetchShareRoles: mocks.roles } }));
const project = {
  id: 'p',
  typeId: { type: 'project', id: 'p' },
  remote: true,
  invite: mocks.invite,
} as unknown as Project;
const result = { invited: [], skipped: [], failed: [], failed_teams: [], granted_teams: [], skipped_teams: [] };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.roster.mockResolvedValue([]);
  mocks.roles.mockResolvedValue(['guest', 'member']);
  mocks.invite.mockResolvedValue(result);
});
afterEach(cleanup);
describe('sharing project membership', () => {
  it('recognizes pending invites and user ids without treating email case as a new person', () => {
    expect(
      projectNonMembers(
        ['ALICE@example.com', 'user-id', 'new@example.com'],
        [{ user_id: 'id', user_email: 'alice@example.com', role: 'guest', status: 'pending' }],
      ),
    ).toEqual(['new@example.com']);
  });
  it('keeps failed roster unknown and refuses invitation', async () => {
    mocks.roster.mockRejectedValue(new Error('Forbidden'));
    const { result: hook } = renderHook(() => useShareProjectMembership(project, ['a@example.com'], true));
    await waitFor(() => expect(hook.current.status).toBe('error'));
    expect(hook.current.nonMembers).toEqual([]);
    await expect(hook.current.invite({ 'a@example.com': 'guest' })).rejects.toThrow('not been confirmed');
    expect(mocks.invite).not.toHaveBeenCalled();
  });
  it('ignores a roster response after switching projects', async () => {
    let resolveOld!: (value: unknown[]) => void;
    mocks.roster.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const other = { ...project, id: 'other' } as Project;
    const { result: hook, rerender } = renderHook(
      ({ target }) => useShareProjectMembership(target, ['a@example.com'], true),
      { initialProps: { target: project } },
    );
    rerender({ target: other });
    await waitFor(() => expect(hook.current.status).toBe('ready'));
    await act(async () => resolveOld([{ user_email: 'a@example.com', user_id: 'a', role: 'member' }]));
    expect(hook.current.nonMembers).toEqual(['a@example.com']);
  });
  it('None makes no membership mutation', async () => {
    const { result: hook } = renderHook(() => useShareProjectMembership(project, ['a@example.com'], true));
    await waitFor(() => expect(hook.current.status).toBe('ready'));
    await act(() => hook.current.invite({ 'a@example.com': 'none' }));
    expect(mocks.invite).not.toHaveBeenCalled();
  });
  it('checks membership afresh after closing and reopening the draft', async () => {
    mocks.invite.mockResolvedValue({ ...result, invited: [{ email: 'a@example.com' }] });
    const { result: hook, rerender } = renderHook(
      ({ enabled }) => useShareProjectMembership(project, ['a@example.com'], enabled),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(hook.current.status).toBe('ready'));
    await act(() => hook.current.invite({ 'a@example.com': 'guest' }));
    expect(hook.current.nonMembers).toEqual([]);
    rerender({ enabled: false });
    rerender({ enabled: true });
    await waitFor(() => expect(hook.current.status).toBe('ready'));
    expect(hook.current.nonMembers).toEqual(['a@example.com']);
  });
  it('partial failure stops send and retry does not invite the successful person again', async () => {
    mocks.invite.mockResolvedValueOnce({
      ...result,
      invited: [{ email: 'a@example.com' }],
      failed: [{ email: 'b@example.com', message: 'Denied' }],
    });
    const { result: hook } = renderHook(() =>
      useShareProjectMembership(project, ['a@example.com', 'b@example.com'], true),
    );
    await waitFor(() => expect(hook.current.status).toBe('ready'));
    await act(async () => {
      await expect(hook.current.invite({ 'a@example.com': 'guest', 'b@example.com': 'member' })).rejects.toThrow(
        'Denied',
      );
    });
    expect(hook.current.nonMembers).toEqual(['b@example.com']);
    await act(() => hook.current.invite({ 'a@example.com': 'guest', 'b@example.com': 'member' }));
    expect(mocks.invite.mock.calls[1][0]).toEqual([{ idOrEmail: 'b@example.com', role: 'member' }]);
  });
});
