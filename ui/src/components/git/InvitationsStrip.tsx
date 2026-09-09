import type { GitProvider } from '@sdk';
import { Button } from '@src/components/ui/button';
import { useGitInvitations, useRespondInvitation } from '@src/hooks/use-git-providers';
import { notify } from '@src/notifications';
import { Loader2, MailPlus } from 'lucide-react';
import { useState } from 'react';

interface InvitationsStripProps {
  provider: GitProvider;
  enabled?: boolean;
}

/**
 * Compact row of pending repository invitations. Hidden when none exist so the
 * picker dialog stays clean for the common case.
 */
export function InvitationsStrip({ provider, enabled = true }: InvitationsStripProps) {
  const { data: invitations, isLoading } = useGitInvitations(provider, enabled);
  const respond = useRespondInvitation(provider);
  // Per-row in-flight tracker so only the clicked invitation's buttons spin.
  // The shared `respond.isPending` from react-query would otherwise grey out
  // every row's buttons when one is mid-flight, blocking the user from
  // responding to multiple invitations in quick succession.
  const [pendingId, setPendingId] = useState<number | null>(null);

  if (isLoading || !invitations || invitations.length === 0) return null;

  const handleRespond = (id: number, action: 'accept' | 'decline', fullName: string) => {
    setPendingId(id);
    respond.mutate(
      { id, action },
      {
        onSuccess: () => {
          notify.success({
            title: action === 'accept' ? `Accepted ${fullName}` : `Declined ${fullName}`,
            durationMs: 2500,
          });
        },
        onError: (err) => {
          notify.error({
            title: `Failed to ${action} invitation`,
            message: err instanceof Error ? err.message : String(err),
          });
        },
        onSettled: () => {
          setPendingId((cur) => (cur === id ? null : cur));
        },
      },
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <MailPlus className="h-3.5 w-3.5" />
        Pending repo invitations ({invitations.length})
      </div>
      <ul className="flex min-w-0 flex-col gap-1">
        {invitations.map((inv) => {
          const isRowPending = pendingId === inv.id;
          return (
            // `min-w-0` + a truncating inviter: every piece of this row must be
            // able to shrink or be marked `shrink-0`, or the row's min-content
            // floors the whole strip — and, through it, the flex column its
            // siblings stretch to — wider than the dialog it sits in.
            <li key={inv.id} className="flex min-w-0 items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate font-mono">{inv.repo.full_name}</span>
              <span className="min-w-0 flex-[0_1_auto] truncate text-muted-foreground">
                from @{inv.inviter_login}
              </span>
              <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[10px] uppercase text-muted-foreground">
                {inv.permissions}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="h-6 shrink-0 px-2 text-xs"
                disabled={isRowPending}
                onClick={() => handleRespond(inv.id, 'accept', inv.repo.full_name)}
              >
                {isRowPending ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Accept'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 shrink-0 px-2 text-xs"
                disabled={isRowPending}
                onClick={() => handleRespond(inv.id, 'decline', inv.repo.full_name)}
              >
                Decline
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default InvitationsStrip;
