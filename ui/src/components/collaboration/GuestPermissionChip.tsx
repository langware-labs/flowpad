import { Trans, useLingui } from '@lingui/react/macro';
import { CircleCheck, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '@src/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import {
  sessionGrantScope,
  setSessionGrantScope,
  useContactPermissions,
  type ContactKey,
} from '@src/hooks/use-contact-permissions';

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

/** Host-only chip: what the guest is allowed to do on this machine right now —
 *  a standing grant (project / everywhere), this session only, or not yet
 *  approved. Click explains it; while pending it offers Approve now. */
export function GuestPermissionChip({
  contact,
  projectId,
  guestName,
  pending,
  onApprove,
  disabled,
}: {
  contact: ContactKey;
  projectId: string | null;
  guestName: string;
  pending: boolean;
  onApprove: () => void;
  disabled: boolean;
}) {
  const { t } = useLingui();
  const { permissions, refetch, loaded } = useContactPermissions(contact);
  const scope = sessionGrantScope(permissions, projectId);
  const [saving, setSaving] = useState(false);
  const change = async (next: 'project' | 'global' | null) => {
    setSaving(true);
    try {
      await setSessionGrantScope(contact, projectId, scope, next);
      await refetch?.();
    } finally {
      setSaving(false);
    }
  };
  const options: { value: 'project' | 'global' | null; label: string }[] = [
    { value: null, label: t`Ask me every time` },
    ...(projectId ? [{ value: 'project' as const, label: t`Auto-approve in this project` }] : []),
    { value: 'global', label: t`Always auto-approve` },
  ];
  // Until the grants load the scope reads "this session only" — showing it would flip a moment later.
  if (!pending && !loaded) return null;
  const label = pending ? (
    <Trans>Needs your approval</Trans>
  ) : scope === 'global' ? (
    <Trans>Always auto-approved</Trans>
  ) : scope === 'project' ? (
    <Trans>Auto-approved in this project</Trans>
  ) : (
    <Trans>Approved for this session</Trans>
  );
  const detail = pending ? (
    <Trans>{guestName} is waiting for your approval before any prompt runs on your machine.</Trans>
  ) : scope === 'global' ? (
    <Trans>{guestName} can start live sessions on your machine without asking, in every project.</Trans>
  ) : scope === 'project' ? (
    <Trans>{guestName} can start live sessions on your machine without asking, in this project only.</Trans>
  ) : (
    <Trans>You approved this session only — {guestName} will need your approval again next time.</Trans>
  );
  return (
    <PermissionChip pending={pending} scope={pending ? 'pending' : (scope ?? 'session')} label={label} detail={detail}>
      {!pending && (
        <fieldset className="mt-2 flex flex-col gap-1" disabled={saving} data-testid="live-session-permission-options">
          <legend className="mb-1 text-[11px] text-muted-foreground">
            <Trans>Future sessions from {guestName}:</Trans>
          </legend>
          {options.map((o) => (
            <label key={o.value ?? 'ask'} className="flex cursor-pointer items-center gap-2">
              <input
                type="radio"
                name="live-session-permission"
                checked={scope === o.value}
                onChange={() => void change(o.value)}
                data-testid={`live-session-permission-${o.value ?? 'ask'}`}
              />
              {o.label}
            </label>
          ))}
        </fieldset>
      )}
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

/** Guest-only chip: how the host let this session in, read from the session's
 *  host-authoritative `approved_via` (the host's standing grants stay on the host). */
export function HostApprovalChip({
  hostName,
  pending,
  approvedVia,
}: {
  hostName: string;
  pending: boolean;
  approvedVia: string | null | undefined;
}) {
  const auto = approvedVia === 'standing_grant';
  const label = pending ? (
    <Trans>Awaiting {hostName}'s approval</Trans>
  ) : auto ? (
    <Trans>Auto-approved</Trans>
  ) : (
    <Trans>Approved by {hostName}</Trans>
  );
  const detail = pending ? (
    <Trans>Nothing runs on {hostName}'s machine until they approve this session.</Trans>
  ) : auto ? (
    <Trans>
      {hostName} lets you start live sessions on their machine without asking — this one started right away.
    </Trans>
  ) : (
    <Trans>{hostName} approved this session by hand. A later session may need their approval again.</Trans>
  );
  return (
    <PermissionChip
      pending={pending}
      scope={pending ? 'pending' : auto ? 'standing_grant' : 'manual'}
      label={label}
      detail={detail}
    />
  );
}
