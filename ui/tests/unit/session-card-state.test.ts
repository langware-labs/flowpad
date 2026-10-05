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
    // A failed turn is not a session state: the session stays live (the card marks the prompt).
    [RemoteWorkerSessionStatus.ERROR, 'active'],
    ['garbage', 'requesting'],
  ])('%s → %s', (status, expected) => {
    expect(sessionCardState(status)).toBe(expected);
  });
});
