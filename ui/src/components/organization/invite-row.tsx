/**
 * The one invite control — an address, a role, Send — used wherever an organization or team is
 * shared with someone.
 *
 * Extracted from `org-detail-panel` because there are now two places that share an org: the graph
 * drawer it came from, and the plain People & teams page. Two copies of an invite box is two role
 * pickers that drift apart, and the role picker is the part with a rule in it.
 *
 * **The roles offered are capped by the caller's own rank** (`grantableRoles`), which mirrors the
 * hub's `can_assign`: a role at or above the granter's is refused. The list used to be the flat
 * `['admin', 'editor', 'member', 'reader']`, so an organization's ADMIN was shown `admin` as the
 * first option and every attempt to use it came back refused — the one entry that could never
 * work sitting at the top of the menu. An owner still sees it, because for an owner it works.
 *
 * `me` is the caller's own roster row, and both call sites render this only once that has
 * resolved -- the drawer because `canInviteMembers` needs a rank to be true at all, the share panel
 * because it waits for its roster. So an unknown rank offers nothing rather than guessing.
 */
import type { EntityMember, TypeId } from '@sdk';
import { Loader2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

import { grantableRoles } from '@src/components/conversation/participant-display';
import { Button } from '@src/components/ui/button';
import { notify } from '@src/notifications';

export interface InviteRowProps {
  entityTypeId: TypeId;
  onInvited: () => void;
  /** The caller's own membership row, which caps what they may hand out. */
  me?: EntityMember | null;
  /** Distinguishes the two mounts in tests and notifications. */
  testIdPrefix?: string;
}

export function InviteRow({ entityTypeId, onInvited, me, testIdPrefix = 'org' }: InviteRowProps) {
  const { t } = useLingui();
  const roles = grantableRoles(me as never);
  const [email, setEmail] = useState('');
  // `member` when the caller may confer it, else the most privileged thing they can — never a role
  // that would be refused.
  const [role, setRole] = useState(() => (roles.includes('member') ? 'member' : (roles[0] ?? '')));
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    const trimmed = email.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const { dataManager } = await import('@sdk');
      const entity = await dataManager.getByTypeId<never>(entityTypeId);
      await (entity as unknown as { inviteMember: (e: string, r: string) => Promise<void> }).inviteMember(
        trimmed,
        role,
      );
      setEmail('');
      notify.success({ title: t`Invitation sent`, message: t`Invited ${trimmed}.`, id: 'org-invite' });
      onInvited();
    } catch (err) {
      notify.error({
        title: t`Invite failed`,
        message: err instanceof Error ? err.message : t`Unknown error.`,
        id: 'org-invite',
      });
    } finally {
      setBusy(false);
    }
  }, [busy, email, entityTypeId, onInvited, role, t]);

  return (
    <div className="flex items-center gap-2 rounded-md border border-border p-2">
      <input
        autoFocus
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
        }}
        placeholder={t`name@example.com`}
        data-testid={`${testIdPrefix}-invite-email`}
        className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-1 text-sm"
      />
      {/* The role is chosen at invite time rather than defaulted silently — the
          person doing the inviting is the one who knows what the invitee is for. */}
      <select
        value={role}
        onChange={(e) => setRole(e.target.value)}
        data-testid={`${testIdPrefix}-invite-role`}
        aria-label={t`Role`}
        className="rounded-md border border-border bg-background px-2 py-1 text-sm"
      >
        {roles.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        disabled={busy || !email.trim()}
        onClick={() => void submit()}
        data-testid={`${testIdPrefix}-invite-submit`}
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        <Trans>Send</Trans>
      </Button>
    </div>
  );
}
