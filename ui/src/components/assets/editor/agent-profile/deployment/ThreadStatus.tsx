import { Trans } from '@lingui/react/macro';
import type { DeploymentThread } from '@sdk';

/** What is happening in a thread now — shown only when something is (idle says nothing). */
export function ThreadStatus({ status }: { status: DeploymentThread['status'] }) {
  if (status === 'live') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-[10.5px] font-medium text-green-700 dark:text-green-400" data-testid="thread-status-live">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
        <Trans>Live call</Trans>
      </span>
    );
  }
  if (status === 'working') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-blue-500/12 px-2 py-0.5 text-[10.5px] font-medium text-blue-700 dark:text-blue-400" data-testid="thread-status-working">
        <Trans>Working</Trans>
      </span>
    );
  }
  if (status === 'ended') {
    return (
      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10.5px] text-muted-foreground" data-testid="thread-status-ended">
        <Trans>Ended</Trans>
      </span>
    );
  }
  return null;
}
