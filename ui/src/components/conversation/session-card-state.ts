import { RemoteWorkerSessionStatus } from '@sdk';

/** The card's rendered state — one per lifecycle status, plus `requesting`
 *  for a session whose row has not synced yet (the guest just sent). */
export type SessionCardState = 'requesting' | 'pending' | 'active' | 'paused' | 'ended' | 'declined' | 'error';

export function sessionCardState(status: string | null | undefined): SessionCardState {
  switch (status) {
    case RemoteWorkerSessionStatus.PENDING:
      return 'pending';
    case RemoteWorkerSessionStatus.IDLE:
    case RemoteWorkerSessionStatus.RUNNING:
      return 'active';
    case RemoteWorkerSessionStatus.PAUSED:
      return 'paused';
    case RemoteWorkerSessionStatus.ENDED:
      return 'ended';
    case RemoteWorkerSessionStatus.DECLINED:
      return 'declined';
    case RemoteWorkerSessionStatus.ERROR:
      return 'error';
    case RemoteWorkerSessionStatus.DRAFT:
    default:
      return 'requesting';
  }
}
