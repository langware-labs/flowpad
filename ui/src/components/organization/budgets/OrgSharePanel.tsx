/**
 * Sharing an organization from the People & teams page: who is on it, at what role, and the box to
 * add someone.
 *
 * The page it sits on is about the MONEY — org, teams, people, and how much each may spend. This
 * is the other half of running an organization, and until now it existed only in the Organization
 * WorldView's drawer (`org-detail-panel`), which is the advanced view. So the plain page could
 * create teams and divide budgets but had no way to hand the organization to anybody, which is the
 * first thing an owner wants to do with one.
 *
 * **Nothing here is new machinery.** The roster rows are `MemberRow` and the add box is
 * `InviteRow` — the same two components the drawer uses, with the same rank rules
 * (`assignableRolesForMember`, `grantableRoles`) mirroring the hub's `can_assign`. What that
 * buys, without a line of policy in this file: an admin may add and re-role people below them,
 * cannot touch the owner or a fellow admin, cannot promote anyone to admin, and cannot change
 * their own role.
 *
 * **Opened, not always shown.** The roster is a fetch per organization, and the page's whole shape
 * is "pay for what you actually look at" — the same reason a team's people list stays closed until
 * someone opens it.
 */
import { TypeId } from '@sdk';
import { Loader2, UserPlus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Plural, Trans, useLingui } from '@lingui/react/macro';

import { useLocalUser } from '@src/components/conversation/useLocalUser';
import { InviteRow } from '@src/components/organization/invite-row';
import {
  MemberRow,
  isGroupMember,
  memberPrincipalId,
  type MemberActions,
} from '@src/components/organization/member-list';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { useMembers } from '@src/hooks/use-members';
import { notify } from '@src/notifications';

/** The header button. Rendered only where the hub says the caller may manage members. */
export function ShareOrgButton({ orgId, orgName }: { orgId: string; orgName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" data-testid="org-share-open" onClick={() => setOpen(true)}>
        <UserPlus className="h-4 w-4" />
        <Trans>Share</Trans>
      </Button>
      {open && <OrgSharePanel orgId={orgId} orgName={orgName} onOpenChange={setOpen} />}
    </>
  );
}

function OrgSharePanel({
  orgId,
  orgName,
  onOpenChange,
}: {
  orgId: string;
  orgName: string;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const { localUser } = useLocalUser();
  const typeId = useMemo(() => new TypeId('organization', orgId), [orgId]);
  const { members, ready, updating, removeMember, setRole, refresh } = useMembers(typeId);

  const me = members.find((m) => !!m.user_id && !!localUser?.id && m.user_id === localUser.id) ?? null;
  // People and teams are listed apart because they are different things: a team confers its role on
  // everyone inside it, so reading "12 people" off a mixed list would be wrong by however many
  // teams are in it. The drawer already makes this split; it is not worth making differently here.
  const people = useMemo(() => members.filter((m) => !isGroupMember(m as never)), [members]);
  const teams = useMemo(() => members.filter((m) => isGroupMember(m as never)), [members]);

  const actions: MemberActions = useMemo(
    () => ({
      onSetRole: async (principalId, role) => {
        try {
          await setRole(principalId, role);
        } catch (err) {
          notify.error({
            title: t`Could not change role`,
            message: err instanceof Error ? err.message : t`Unknown error.`,
            id: 'org-role',
          });
        }
      },
      onRemove: async (principalId) => {
        try {
          await removeMember(principalId);
        } catch (err) {
          notify.error({
            title: t`Could not remove`,
            message: err instanceof Error ? err.message : t`Unknown error.`,
            id: 'org-remove',
          });
        }
      },
    }),
    [removeMember, setRole, t],
  );

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl" data-testid="org-share-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Share {orgName}</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              People you add here can see this organization. An admin can run its teams and divide its budget; only the
              owner can change the organization's own total, its provider key, or its name.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        {/* Behind the roster load, not above it: the role picker is capped by the CALLER's rank,
            which is read off their own row, so offering the menu before that resolves would be
            offering roles nobody has established the caller may confer. */}
        {!ready ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <Trans>Loading people…</Trans>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <InviteRow entityTypeId={typeId} me={me} testIdPrefix="org-share" onInvited={() => void refresh()} />
            <Section label={<Plural value={people.length} one="# person" other="# people" />} testId="org-share-people">
              {people.map((member) => (
                <MemberRow
                  key={memberPrincipalId(member) ?? member.email ?? ''}
                  member={member}
                  isSelf={!!me && memberPrincipalId(member) === memberPrincipalId(me)}
                  me={me}
                  manage
                  actions={actions}
                />
              ))}
            </Section>
            {teams.length > 0 && (
              <Section label={<Plural value={teams.length} one="# team" other="# teams" />} testId="org-share-teams">
                {teams.map((member) => (
                  <MemberRow
                    key={memberPrincipalId(member) ?? ''}
                    member={member}
                    isSelf={false}
                    me={me}
                    manage
                    actions={actions}
                  />
                ))}
              </Section>
            )}
          </div>
        )}
        {updating && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            <Trans>Saving…</Trans>
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Section({ label, testId, children }: { label: React.ReactNode; testId: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1" data-testid={testId}>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</h3>
      {children}
    </section>
  );
}
