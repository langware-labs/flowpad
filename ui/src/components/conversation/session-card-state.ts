import { RemoteWorkerSessionStatus } from '@sdk';

/** The card's rendered state — one per lifecycle status, plus `requesting`
 *  for a session whose row has not synced yet (the guest just sent). A failed
 *  turn is not a session state: the session stays live (the next prompt runs)
 *  and the card marks the failed prompt with a Retry instead. */
export type SessionCardState = 'requesting' | 'pending' | 'active' | 'paused' | 'ended' | 'declined';

export function sessionCardState(status: string | null | undefined): SessionCardState {
  switch (status) {
    case RemoteWorkerSessionStatus.PENDING:
      return 'pending';
    case RemoteWorkerSessionStatus.IDLE:
    case RemoteWorkerSessionStatus.RUNNING:
    case RemoteWorkerSessionStatus.ERROR:
      return 'active';
    case RemoteWorkerSessionStatus.PAUSED:
      return 'paused';
    case RemoteWorkerSessionStatus.ENDED:
      return 'ended';
    case RemoteWorkerSessionStatus.DECLINED:
      return 'declined';
    case RemoteWorkerSessionStatus.DRAFT:
    default:
      return 'requesting';
  }
}
