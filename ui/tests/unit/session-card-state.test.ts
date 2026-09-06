import { RemoteWorkerSessionStatus } from '@sdk';
import { describe, expect, it } from 'vitest';
import { sessionCardState } from '@src/components/conversation/session-card-state';

describe('sessionCardState', () => {
  it.each([
    [RemoteWorkerSessionStatus.DRAFT, 'requesting'],
    [null, 'requesting'],
    [undefined, 'requesting'],
    [RemoteWorkerSessionStatus.PENDING, 'pending'],
    [RemoteWorkerSessionStatus.IDLE, 'active'],
    [RemoteWorkerSessionStatus.RUNNING, 'active'],
    [RemoteWorkerSessionStatus.PAUSED, 'paused'],
    [RemoteWorkerSessionStatus.ENDED, 'ended'],
    [RemoteWorkerSessionStatus.DECLINED, 'declined'],
    [RemoteWorkerSessionStatus.ERROR, 'error'],
    ['garbage', 'requesting'],
  ])('%s → %s', (status, expected) => {
    expect(sessionCardState(status as string | null | undefined)).toBe(expected);
  });
});
