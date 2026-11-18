/**
 * A help desk itself — `/dock/support_desk/<hub project id>`, one view on the hub page and the desktop.
 *
 * To its team it is where the desk is run: on or off, its tickets, who answers, and the link people ask
 * through. To anyone else the same address is that link's landing: the desk's card, and one button that adds
 * it to their own help desks (like a contact — no role, nothing of the project).
 */
import {
  TypeId,
  addMyHelpDesk,
  ensureHelpDeskSources,
  cloudManager,
  getMembers,
  helpDeskAgents,
  helpDeskCard,
  helpDeskProject,
  helpDeskTickets,
  inviteHelpDeskStaff,
  myHelpDesks,
  setHelpDeskEnabled,
  HelpDeskAgentSide,
  type HelpDeskAgent,
  type HelpDeskCard,
  type HelpDeskProject,
  type HelpDeskTicketRow,
  type Participant,
} from '@sdk';
import { isClosedConversation } from '@sdk/entities/conversation';
import { useAuth } from '@sdk/react/hooks';
import { Trans, useLingui } from '@lingui/react/macro';
import { Check, LifeBuoy } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button } from '@src/components/ui/button';
import { CopyButton } from '@src/components/ui/copy-button';
import { Input } from '@src/components/ui/input';
import { SegmentedControl } from '@src/components/ui/segmented-control';
import { Switch } from '@src/components/ui/switch';
import { helpDeskUrl } from '@src/lib/hub-page-url';
import { DockPointer } from '@src/navigation/DockPointer';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { HelpDeskAgentDialog } from './HelpDeskAgentDialog';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

/** A desk's title line: its name, what it is, then whatever the viewer may do with it. */
function DeskTitle({ name, children }: { name: string; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <LifeBuoy className="h-5 w-5 shrink-0 text-red-500" />
      <h1 className="text-2xl font-semibold" data-testid="help-desk-name">
        {name}
      </h1>
      <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
        <Trans>Help desk</Trans>
      </span>
      {children}
    </div>
  );
}

type Loaded =
  | {
      as: 'team';
      project: HelpDeskProject;
      tickets: HelpDeskTicketRow[];
      staff: Participant[];
      agents: HelpDeskAgent[];
    }
  | { as: 'asker'; card: HelpDeskCard; mine: boolean }
  | { as: 'nobody' };

export function HelpDeskPage({ deskId }: { deskId: string }) {
  const { t } = useLingui();
  const { cloudUser } = useAuth();
  const me = cloudUser?.id ?? null;
  const { navigation } = useDockNavigation();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(false);
  const [invitee, setInvitee] = useState('');
  const [tab, setTab] = useState<'tickets' | 'team' | 'settings'>('tickets');
  const [settingUp, setSettingUp] = useState<HelpDeskAgentSide | null>(null);

  const load = useCallback(async () => {
    if (!deskId) return setLoaded({ as: 'nobody' });
    try {
      // The project row answers only its team; the queue and roster are theirs too.
      const project = await helpDeskProject(deskId);
      const [tickets, staff, agents] = await Promise.all([
        helpDeskTickets(deskId).catch(() => []),
        getMembers(new TypeId('project', deskId)).catch(() => []),
        helpDeskAgents(deskId).catch(() => []),
      ]);
      setLoaded({ as: 'team', project, tickets, staff, agents });
    } catch {
      try {
        const [card, desks] = await Promise.all([helpDeskCard(deskId), me ? myHelpDesks(me) : Promise.resolve([])]);
        setLoaded({ as: 'asker', card, mine: desks.some((d) => d.id === deskId) });
      } catch {
        setLoaded({ as: 'nobody' });
      }
    }
  }, [deskId, me]);
  useEffect(() => void load(), [load]);
  // A ticket is read from this computer's copy: bring the desk's tickets here while its page is open, so a
  // click on one only navigates.
  const isTeam = loaded?.as === 'team';
  useEffect(() => {
    if (isTeam) void ensureHelpDeskSources(deskId).catch(() => undefined);
  }, [isTeam, deskId]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (!loaded) return null;
  if (loaded.as === 'nobody') {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 text-sm text-muted-foreground" data-testid="help-desk-unavailable">
        <Trans>This help desk is not available. It may be turned off, or the link may be wrong.</Trans>
      </div>
    );
  }

  if (loaded.as === 'asker') {
    const { card, mine } = loaded;
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-10" data-testid="help-desk-card">
        <DeskTitle name={card.display_name} />
        {mine ? (
          <p className="flex items-center gap-2 text-sm" data-testid="help-desk-added">
            <Check className="h-4 w-4 text-emerald-500" />
            <Trans>In your help desks. Ask it from Ask for help, in any project.</Trans>
          </p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              <Trans>Add it to your help desks to ask {card.display_name} for help, like a contact.</Trans>
            </p>
            <Button
              className="w-fit"
              disabled={busy || !me}
              // The hub answers the new list: no reload of a page that already shows everything else.
              onClick={() => {
                setBusy(true);
                void addMyHelpDesk(me!, deskId)
                  .then((desks) => setLoaded({ ...loaded, mine: desks.some((d) => d.id === deskId) }))
                  .finally(() => setBusy(false));
              }}
              data-testid="help-desk-add"
            >
              <Trans>Add to my help desks</Trans>
            </Button>
          </>
        )}
      </div>
    );
  }

  const { project, tickets, staff, agents } = loaded;
  const name = project.helpdesk?.display_name || project.name || t`Help desk`;
  const on = !!project.helpdesk?.enabled;
  // The hub's own address: where this page is served from on the hub, the cloud app's elsewhere.
  const link = helpDeskUrl(cloudManager.cloudAppUrl || window.location.origin, deskId);
  const row = 'flex items-center gap-3 border-b border-border/60 px-4 py-3 text-sm last:border-b-0';
  return (
    <div
      className="mx-auto flex w-full max-w-3xl flex-col gap-6 overflow-y-auto px-4 py-10"
      data-testid="help-desk-page"
    >
      <DeskTitle name={name}>
        <span className="flex-1" />
        <span
          className={on ? 'text-sm text-emerald-500' : 'text-sm text-muted-foreground'}
          data-testid="help-desk-state"
        >
          {on ? <Trans>On — people can ask</Trans> : <Trans>Off — nobody can ask yet</Trans>}
        </span>
        <Switch
          checked={on}
          disabled={busy}
          onCheckedChange={(next) => void run(() => setHelpDeskEnabled(deskId, next, name))}
          aria-label={t`Help desk on or off`}
          data-testid="help-desk-switch"
        />
      </DeskTitle>

      <SegmentedControl
        options={[
          ['tickets', tickets.length ? t`Tickets · ${tickets.length}` : t`Tickets`],
          ['team', t`Team`],
          ['settings', t`Settings`],
        ]}
        value={tab}
        onChange={setTab}
        testId="help-desk-tabs"
        className="self-start"
      />

      {tab === 'tickets' && (
        <section className="rounded-lg border border-border" data-testid="help-desk-tickets">
          {tickets.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              <Trans>No tickets yet. Share the link — whoever opens it can ask {name}.</Trans>
            </p>
          ) : (
            tickets.map((ticket) => (
              <button
                key={ticket.conversation_id}
                type="button"
                className={`${row} w-full text-start hover:bg-muted/40`}
                onClick={() => navigation.openDockOnThisPage(DockPointer.forConversation(ticket.conversation_id))}
                data-testid="help-desk-ticket-row"
              >
                <span className="shrink-0 rounded border px-1.5 text-[11px] text-muted-foreground">
                  {isClosedConversation(ticket.status) ? (
                    <Trans>Closed</Trans>
                  ) : ticket.picked_up_by?.length ? (
                    <Trans>Picked up</Trans>
                  ) : (
                    <Trans>Not picked up</Trans>
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate">{ticket.preview || ticket.title}</span>
              </button>
            ))
          )}
        </section>
      )}

      {tab === 'team' && (
        <section className="rounded-lg border border-border" data-testid="help-desk-team">
          <div className={row}>
            <span className="w-32 shrink-0 text-muted-foreground">
              <Trans>Staff members</Trans>
            </span>
            <span className="flex min-w-0 flex-1 flex-wrap gap-1.5" data-testid="help-desk-staff">
              {staff.map((member) => (
                <span key={member.user_id ?? member.email} className="rounded-full border px-2.5 py-0.5 text-xs">
                  {member.name || member.email}
                </span>
              ))}
            </span>
          </div>
          <form
            className={row}
            onSubmit={(event) => {
              event.preventDefault();
              const who = invitee.trim();
              if (who) void run(() => inviteHelpDeskStaff(deskId, who)).then(() => setInvitee(''));
            }}
          >
            <span className="w-32 shrink-0" />
            <Input
              className="h-8 flex-1"
              placeholder={t`Add a staff member by email`}
              value={invitee}
              onChange={(event) => setInvitee(event.target.value)}
              data-testid="help-desk-invite-input"
            />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={busy || !invitee.trim()}
              data-testid="help-desk-invite"
            >
              <Trans>Invite</Trans>
            </Button>
          </form>
        </section>
      )}

      {tab === 'settings' && (
        <section className="rounded-lg border border-border" data-testid="help-desk-settings">
          <div className={row}>
            <span className="w-32 shrink-0 text-muted-foreground">
              <Trans>Who can ask</Trans>
            </span>
            <span className="flex-1">
              <Trans>Anyone with the link</Trans>
            </span>
          </div>
          <div className={row}>
            <span className="w-32 shrink-0 text-muted-foreground">
              <Trans>Invite link</Trans>
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs" data-testid="help-desk-link">
              {link}
            </span>
            <CopyButton
              value={link}
              testId="help-desk-copy-link"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs hover:bg-muted/40"
              iconClassName="h-3.5 w-3.5"
              label={<Trans>Copy</Trans>}
              copiedLabel={<Trans>Copied</Trans>}
            />
          </div>
          {/* The optional agents run on a computer, so they are set up from the desktop app. */}
          {!isHubOnly() &&
            Object.values(HelpDeskAgentSide).map((side) => {
              const agent = agents.find((a) => a.side === side);
              return (
                <div key={side} className={row} data-testid={`help-desk-agent-${side}`}>
                  <span className="w-32 shrink-0 text-muted-foreground">
                    {side === HelpDeskAgentSide.CUSTOMER ? <Trans>Customer agent</Trans> : <Trans>Team agent</Trans>}
                  </span>
                  <span className="flex-1 text-xs text-muted-foreground">
                    {agent ? (
                      <span className="text-sm text-foreground">{agent.agent_name}</span>
                    ) : side === HelpDeskAgentSide.CUSTOMER ? (
                      <Trans>
                        Optional — on the customer side: makes sure the team has everything it needs from the customer.
                      </Trans>
                    ) : (
                      <Trans>
                        Optional — on the team side: writes a first root-cause analysis for a team member to review.
                      </Trans>
                    )}
                  </span>
                  {agent ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        agent.agent_id &&
                        navigation.openDockOnThisPage(
                          DockPointer.forAssetEditorByTypeId('agent', new TypeId('agent', agent.agent_id)),
                        )
                      }
                    >
                      <Trans>Open</Trans>
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setSettingUp(side)}
                      data-testid={`help-desk-agent-setup-${side}`}
                    >
                      <Trans>Set up</Trans>
                    </Button>
                  )}
                </div>
              );
            })}
        </section>
      )}
      {settingUp && (
        <HelpDeskAgentDialog
          deskId={deskId}
          deskName={name}
          side={settingUp}
          onOpenChange={(open) => !open && setSettingUp(null)}
          onLaunched={() => void load()}
        />
      )}
    </div>
  );
}
