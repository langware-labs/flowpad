import { RemoteWorkerSessionStatus } from '@sdk';
import { describe, expect, it } from 'vitest';
import { isSessionExpired, sessionCardState } from '@src/components/conversation/session-card-state';

describe('sessionCardState', () => {
  it.each([
    [RemoteWorkerSessionStatus.DRAFT, 'requesting'],
    [null, 'requesting'],
    [undefined, 'requesting'],
    [RemoteWorkerSessionStatus.PENDING, 'pending'],
    [RemoteWorkerSessionStatus.IDLE, 'active'],
    [RemoteWorkerSessionStatus.RUNNING, 'active'],
    [RemoteWorkerSessionStatus.ENDED, 'ended'],
    [RemoteWorkerSessionStatus.DECLINED, 'declined'],
    // A failed turn is not a session state: the session stays live (the card marks the prompt).
    [RemoteWorkerSessionStatus.ERROR, 'active'],
    ['garbage', 'requesting'],
  ])('%s → %s', (status, expected) => {
    expect(sessionCardState(status)).toBe(expected);
  });
});

describe('isSessionExpired', () => {
  const approved = '2026-10-07T10:00:00Z';
  const at = (iso: string) => Date.parse(iso);

  it('a live session is over at the 2-hour cap, counted from approval', () => {
    const s = { status: RemoteWorkerSessionStatus.IDLE, approved_at: approved };
    expect(isSessionExpired(s, at('2026-10-07T11:59:59Z'))).toBe(false);
    expect(isSessionExpired(s, at('2026-10-07T12:00:00Z'))).toBe(true);
  });

  it('falls back to the start stamp before approval', () => {
    const s = { status: RemoteWorkerSessionStatus.PENDING, started_at: approved };
    expect(isSessionExpired(s, at('2026-10-07T12:00:01Z'))).toBe(true);
  });

  it('a terminal or unstamped session never reads as expired', () => {
    const late = at('2026-10-09T00:00:00Z');
    expect(isSessionExpired({ status: RemoteWorkerSessionStatus.ENDED, approved_at: approved }, late)).toBe(false);
    expect(isSessionExpired({ status: RemoteWorkerSessionStatus.DECLINED, approved_at: approved }, late)).toBe(false);
    expect(isSessionExpired({ status: RemoteWorkerSessionStatus.IDLE }, late)).toBe(false);
    expect(isSessionExpired(null, late)).toBe(false);
  });
});
