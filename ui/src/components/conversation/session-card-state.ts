import { RemoteWorkerSessionStatus } from '@sdk';

/** The card's rendered state — one per lifecycle status, plus `requesting`
 *  for a session whose row has not synced yet (the guest just sent). A failed
 *  turn is not a session state: the session stays live (the next prompt runs)
 *  and the card marks the failed prompt with a Retry instead. */
export type SessionCardState = 'requesting' | 'pending' | 'active' | 'ended' | 'declined';

export function sessionCardState(status: string | null | undefined): SessionCardState {
  switch (status) {
    case RemoteWorkerSessionStatus.PENDING:
      return 'pending';
    case RemoteWorkerSessionStatus.IDLE:
    case RemoteWorkerSessionStatus.RUNNING:
    case RemoteWorkerSessionStatus.ERROR:
      return 'active';
    case RemoteWorkerSessionStatus.ENDED:
      return 'ended';
    case RemoteWorkerSessionStatus.DECLINED:
      return 'declined';
    case RemoteWorkerSessionStatus.DRAFT:
    default:
      return 'requesting';
  }
}

/** Hard cap on a live session's length, from approval (else start) — mirrors
 *  the backend's `MAX_SESSION_LENGTH`; the backend sweep ends the row, this
 *  only stops the card reading "connected" in the minute before it does. */
export const MAX_SESSION_LENGTH_MS = 2 * 60 * 60 * 1000;

type CappedSession = { status?: string | null; approved_at?: string | null; started_at?: string | null };

/** Epoch ms when a live session hits the cap; null for a terminal or unstamped one. */
export function sessionExpiresAt(session: CappedSession | null | undefined): number | null {
  if (!session) return null;
  if (session.status === RemoteWorkerSessionStatus.ENDED || session.status === RemoteWorkerSessionStatus.DECLINED) {
    return null;
  }
  const began = Date.parse(session.approved_at || session.started_at || '');
  return Number.isFinite(began) ? began + MAX_SESSION_LENGTH_MS : null;
}

export function isSessionExpired(session: CappedSession | null | undefined, now: number): boolean {
  const ends = sessionExpiresAt(session);
  return ends !== null && now >= ends;
}
