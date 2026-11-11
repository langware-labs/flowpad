import { Trans } from '@lingui/react/macro';
import { CircleCheck, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { type ReactNode } from 'react';
import { Button } from '@src/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';

/** The chip + its explaining popover, shared by both sides of a session. */
function PermissionChip({
  pending,
  scope,
  label,
  detail,
  children,
}: {
  pending: boolean;
  scope: string;
  label: ReactNode;
  detail: ReactNode;
  children?: ReactNode;
}) {
  const Icon = pending ? ShieldQuestion : ShieldCheck;
  // The chip sits on a clickable line: keep its clicks (and the popover's,
  // which bubble through the React tree) from opening the session.
  return (
    <span className="contents" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="live-session-permission-chip"
            data-scope={scope}
            className={
              pending
                ? 'inline-flex items-center gap-1 rounded-full border border-amber-500/60 bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-800 hover:bg-amber-500/25 dark:text-amber-200'
                : 'inline-flex items-center gap-1 rounded-full border border-emerald-500/50 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-800 hover:bg-emerald-500/20 dark:text-emerald-200'
            }
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            {label}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72 text-xs" data-testid="live-session-permission-detail">
          <p>{detail}</p>
          {children}
        </PopoverContent>
      </Popover>
    </span>
  );
}

/** Host-only chip: whether the guest may run prompts on this machine right now.
 *  An approval covers this session only — nothing ever approves a session for
 *  the host. Click explains it; while pending it offers Approve now. */
export function GuestPermissionChip({
  guestName,
  pending,
  onApprove,
  disabled,
}: {
  guestName: string;
  pending: boolean;
  onApprove: () => void;
  disabled: boolean;
}) {
  const label = pending ? <Trans>Needs your approval</Trans> : <Trans>Approved for this session</Trans>;
  const detail = pending ? (
    <Trans>{guestName} is waiting for your approval before any prompt runs on your machine.</Trans>
  ) : (
    <Trans>You approved this session only — {guestName} will need your approval again next time.</Trans>
  );
  return (
    <PermissionChip pending={pending} scope={pending ? 'pending' : 'session'} label={label} detail={detail}>
      {pending && (
        <Button
          size="sm"
          className="mt-2 bg-blue-600 text-white hover:bg-blue-500"
          onClick={onApprove}
          disabled={disabled}
          data-testid="live-session-permission-approve"
        >
          <CircleCheck className="me-1.5 h-4 w-4" />
          <Trans>Approve now</Trans>
        </Button>
      )}
    </PermissionChip>
  );
}

/** Guest-only chip: whether the host has approved this session yet. */
export function HostApprovalChip({ hostName, pending }: { hostName: string; pending: boolean }) {
  const label = pending ? <Trans>Awaiting {hostName}'s approval</Trans> : <Trans>Approved by {hostName}</Trans>;
  const detail = pending ? (
    <Trans>Nothing runs on {hostName}'s machine until they approve this session.</Trans>
  ) : (
    <Trans>{hostName} approved this session by hand. A later session needs their approval again.</Trans>
  );
  return <PermissionChip pending={pending} scope={pending ? 'pending' : 'manual'} label={label} detail={detail} />;
}
