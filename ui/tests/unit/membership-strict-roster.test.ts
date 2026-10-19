import { afterEach, expect, it, vi } from 'vitest';
import { dataManager, membershipService, TypeId, Project } from '@sdk';
const ref = new TypeId(Project.type, '14381128-ea28-42ef-bfa5-cf5753c64803');
afterEach(() => vi.restoreAllMocks());
it('strict roster requires authority and normalizes reflected member email', async () => {
  const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue([{ user_id: 'alice', email: 'alice@example.com', name: 'Alice', role: 'guest', status: 'pending' }]);
  const roster = await membershipService.fetchMembershipsStrict(ref);
  expect(call.mock.calls[0][0].queryParameters).toEqual({ require_authoritative: true });
  expect(roster[0]).toMatchObject({ user_email: 'alice@example.com', user_name: 'Alice', status: 'pending' });
});
it('strict roster propagates failure while existing tolerant readers keep empty fallback', async () => {
  const call = vi.spyOn(dataManager, 'callAction').mockRejectedValue(new Error('Offline'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(membershipService.fetchMembershipsStrict(ref)).rejects.toThrow('Offline');
  await expect(membershipService.fetchMemberships(ref)).resolves.toEqual([]);
  expect(call.mock.calls[1][0].queryParameters).toEqual({});
});
