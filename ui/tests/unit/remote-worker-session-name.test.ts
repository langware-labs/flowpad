import { RemoteWorkerSession } from '@sdk';
import { dataContext } from '@sdk/FlowSync/context';
import { afterEach, describe, expect, it, vi } from 'vitest';

const HOST = 'f33565cc-1640-4b5b-bcb5-2be61ddeec5a';
const GUEST = 'a7172bbb-921d-4071-a4f1-d6c27ab3bace';
const row = (extra: Partial<RemoteWorkerSession> = {}) =>
  new RemoteWorkerSession({
    host_user_id: HOST,
    guest_user_id: GUEST,
    host_name: 'lshost-1',
    guest_name: 'lsguest-2',
    ...extra,
  });
const signedInAs = (id: string | null) =>
  // `cloudUser` is a computed getter that cannot be redefined; stub the lookup under it.
  vi.spyOn(dataContext, 'getContextEntity').mockReturnValue(id ? ({ id } as never) : null);

describe('RemoteWorkerSession.getDisplayName names the other side', () => {
  afterEach(() => vi.restoreAllMocks());

  it('the guest sees the host', () => {
    signedInAs(GUEST);
    expect(row().getDisplayName()).toBe('Live session · lshost-1');
  });

  it('the host sees the guest — by cloud id, or by the host-local process', () => {
    signedInAs(HOST);
    expect(row().getDisplayName()).toBe('Live session · lsguest-2');
    signedInAs(null);
    expect(row({ host_process_id: '911219a8-bff1-4a69-9cdb-438e33a43a5c' }).getDisplayName()).toBe(
      'Live session · lsguest-2',
    );
  });
});
