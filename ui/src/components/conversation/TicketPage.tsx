/**
 * A help-desk ticket, as its desk's staff work it: the conversation with the person asking on the left, the
 * desk's private team conversation on the right, on ONE timeline (a note sits level with the moment it was
 * written). Two conversations underneath -- the person asking is simply not in the second -- so nothing typed
 * on the right can reach them. One view, on the hub page and the desktop. On a narrow screen the two sides
 * are two tabs of the same page.
 */
import { Conversation, TypeId, openTeamConversation, teamConversationOf } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { GripVertical, Lock } from 'lucide-react';
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ComponentProps,
} from 'react';
import { useIsMobile } from '@src/hooks/use-mobile';
import { ConversationView, type ConversationEmbed, type EmbeddedFeed } from './ConversationView';
import { LatestScroll } from './LatestScroll';
import { MembersAvatarStack } from './MembersAvatarStack';
import { MessageComposer } from './MessageComposer';
import { TicketHeaderSlot } from './ticket-header-slot';
import { ticketTimeline, timelineKey, type TicketSide } from './ticket-timeline';

const SPLIT_KEY = 'flowpad.ticket-page.split';
const SPLIT_MIN = 28;
const SPLIT_MAX = 72;
const EMPTY_FEED = { items: [], hasOlder: false };
const DIM = 0.45;

/** A message that carries chips keeps its controls apart from them: a gap and a line. */
const CONTROLS_RULE = `
[data-testid="ticket-timeline"] .space-y-1\\.5 + [data-testid="message-reply-forward"] {
  margin-top: 12px; padding-top: 10px; border-top: 1px solid hsl(var(--border));
}`;

function storedSplit(): number {
  try {
    const value = Number(window.localStorage.getItem(SPLIT_KEY));
    return value >= SPLIT_MIN && value <= SPLIT_MAX ? value : 50;
  } catch {
    return 50;
  }
}

type TicketPageProps = Omit<ComponentProps<typeof ConversationView>, 'embed'>;

export function TicketPage(props: TicketPageProps) {
  const { conversationId } = props;
  const { t } = useLingui();
  const narrow = useIsMobile();
  const statusSlot = useContext(TicketHeaderSlot);

  // The team conversation: undefined while asked, null when nobody has opened one.
  const [teamId, setTeamId] = useState<string | null | undefined>(undefined);
  const [customer, setCustomer] = useState<EmbeddedFeed | null>(null);
  const [team, setTeam] = useState<EmbeddedFeed | null>(null);
  const lookUp = useCallback(() => {
    let current = true;
    teamConversationOf(conversationId)
      .then((id) => current && setTeamId(id))
      .catch(() => current && setTeamId((held) => held ?? null));
    return () => {
      current = false;
    };
  }, [conversationId]);
  // Asked on open, and again whenever the ticket moves while the team side is still empty: a teammate or an
  // agent may have opened it meanwhile, and the ticket itself carries nothing that says so.
  const ticketMoves = customer?.items.length ?? 0;
  const ticketLoaded = !!customer?.loaded;
  useEffect(() => {
    if (teamId || !ticketLoaded) return;
    return lookUp();
  }, [lookUp, teamId, ticketLoaded, ticketMoves]);
  useEffect(() => {
    if (teamId) return;
    const onFocus = () => void lookUp();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [lookUp, teamId]);

  // A narrow screen shows one side at a time (a tab each); a wide one lays both out by time.
  const [tab, setTab] = useState<TicketSide>('customer');
  const shown = (side: TicketSide) => !narrow || tab === side;
  const timeline = useMemo(
    () =>
      ticketTimeline(
        shown('customer') ? (customer ?? EMPTY_FEED) : EMPTY_FEED,
        shown('team') && teamId && team ? team : EMPTY_FEED,
      ),
    // `shown` reads `narrow` and `tab`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [customer, team, teamId, narrow, tab],
  );

  // Where each side's controls and composer are drawn (the sides render into them).
  const [controlsSlot, setControlsSlot] = useState<HTMLElement | null>(null);
  const [replySlot, setReplySlot] = useState<HTMLElement | null>(null);
  const [noteSlot, setNoteSlot] = useState<HTMLElement | null>(null);

  // The side being written on; the other is dimmed so it is plain who will read what is typed.
  const [writing, setWriting] = useState<TicketSide | null>(null);
  const dim = (side: TicketSide): CSSProperties => ({
    opacity: writing && writing !== side ? DIM : 1,
    transition: 'opacity 120ms',
  });

  const [split, setSplit] = useState(storedSplit);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const drag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const frame = frameRef.current?.getBoundingClientRect();
    if (!frame || !frame.width || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const next = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, ((event.clientX - frame.left) / frame.width) * 100));
    setSplit(next);
    try {
      window.localStorage.setItem(SPLIT_KEY, String(Math.round(next)));
    } catch {
      // A private window keeps the split for this visit only.
    }
  }, []);

  const columns: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: narrow ? 'minmax(0, 1fr)' : `${split}% minmax(0, 1fr)`,
  };
  const columnOf = (side: TicketSide) => (narrow || side === 'customer' ? 1 : 2);
  const place = useCallback(
    (side: TicketSide) =>
      (key: string): CSSProperties => {
        const row = timeline.rowOf.get(timelineKey(side, key));
        if (!row) return { display: 'none' };
        return {
          gridColumn: narrow || side === 'customer' ? 1 : 2,
          gridRow: row,
          paddingInline: 16,
          opacity: writing && writing !== side ? DIM : undefined,
          transition: 'opacity 120ms',
        };
      },
    [timeline, writing, narrow],
  );

  const asker = customer?.firstSender || t`the customer`;
  // ONE id object per team conversation: the roster is refetched whenever it is handed a new one, and this
  // page re-renders on every feed change -- a fresh object each render asked the hub in a loop.
  const teamTypeId = useMemo(() => (teamId ? new TypeId(Conversation.type, teamId) : null), [teamId]);
  const customerEmbed = useMemo<ConversationEmbed>(
    () => ({
      place: place('customer'),
      onFeed: setCustomer,
      controlsSlot,
      statusSlot,
      composerSlot: replySlot,
      placeholder: t`Reply to ${asker}`,
      locked: { unpicked: t`Pick up to reply to ${asker}`, closed: t`Closed — reopen to reply to ${asker}` },
    }),
    [place, controlsSlot, statusSlot, replySlot, asker, t],
  );
  const teamEmbed = useMemo<ConversationEmbed>(
    () => ({
      place: place('team'),
      onFeed: setTeam,
      controlsSlot: null,
      composerSlot: noteSlot,
      placeholder: t`Note to team`,
    }),
    [place, noteSlot, t],
  );

  const firstNote = useCallback(
    async (text: string) => {
      setTeamId(await openTeamConversation(conversationId, text));
    },
    [conversationId],
  );
  const loadOlder = () =>
    void Promise.all([customer?.hasOlder && customer.loadOlder(), team?.hasOlder && team.loadOlder()]);
  const noNotes = teamId === null || (!!teamId && !!team?.loaded && team.items.length === 0);
  // What the desk sent, marked on the team side: the answer left the building at this point of the story.
  const sent = narrow ? [] : (customer?.items ?? []).filter((item) => !item.fromAsker);
  const teamCount = team?.items.length ?? 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="ticket-page" data-narrow={narrow ? 'true' : 'false'}>
      <style>{CONTROLS_RULE}</style>
      <div ref={setControlsSlot} className="shrink-0 space-y-2 px-4 pt-2" />
      <div ref={frameRef} className="relative flex min-h-0 flex-1 flex-col">
        {/* The team side's ground, the whole height: internal, at a glance. */}
        {shown('team') && (
          <div
            className="pointer-events-none absolute inset-y-0 end-0 bg-muted/30"
            style={{ insetInlineStart: narrow ? 0 : `${split}%` }}
          />
        )}
        {narrow && (
          <div className="relative flex shrink-0 gap-1 border-b border-border px-4 py-1.5" role="tablist" data-testid="ticket-tabs">
            {(['customer', 'team'] as const).map((side) => (
              <button
                key={side}
                type="button"
                role="tab"
                aria-selected={tab === side}
                onClick={() => setTab(side)}
                className={`flex h-7 flex-1 items-center justify-center gap-1.5 rounded text-xs font-medium ${
                  tab === side ? 'bg-accent text-foreground' : 'text-muted-foreground'
                }`}
                data-testid={`ticket-tab-${side}`}
              >
                {side === 'team' && <Lock className="h-3 w-3 text-amber-500" />}
                {side === 'customer' ? asker : teamCount ? t`Team · ${teamCount}` : t`Team`}
              </button>
            ))}
          </div>
        )}
        <div className="relative shrink-0 border-b border-border text-sm" style={columns}>
          {shown('customer') && (
            <div className="flex min-w-0 items-center gap-2 px-4 py-2" style={dim('customer')} data-testid="ticket-customer-header">
              <span className="truncate font-semibold text-foreground">{asker}</span>
              <span className="flex-1" />
              <span className="shrink-0 text-xs text-muted-foreground">
                <Trans>Sees this side</Trans>
              </span>
            </div>
          )}
          {shown('team') && (
            <div className="flex min-w-0 items-center gap-2 px-4 py-2" style={dim('team')} data-testid="ticket-team-header">
              <Lock className="h-3.5 w-3.5 shrink-0 text-amber-500" />
              <span className="font-semibold text-foreground">
                <Trans>Team</Trans>
              </span>
              {teamTypeId && <MembersAvatarStack typeId={teamTypeId} />}
              <span className="flex-1" />
              <span className="truncate text-xs text-amber-500">
                <Trans>Internal · never shown to {asker}</Trans>
              </span>
            </div>
          )}
        </div>
        <LatestScroll
          className="relative py-3"
          after={
            <div className="relative shrink-0 py-2" style={columns}>
              <div
                ref={setReplySlot}
                className="min-w-0 px-4"
                style={{ ...dim('customer'), display: shown('customer') ? undefined : 'none' }}
                onFocusCapture={() => setWriting('customer')}
                onBlurCapture={() => setWriting(null)}
                data-testid="ticket-reply-composer"
              />
              <div
                className="min-w-0 px-4"
                style={{ ...dim('team'), display: shown('team') ? undefined : 'none' }}
                onFocusCapture={() => setWriting('team')}
                onBlurCapture={() => setWriting(null)}
                data-testid="ticket-note-composer"
              >
                <div ref={setNoteSlot} />
                {teamId === null && (
                  <MessageComposer conversationId={conversationId} placeholder={t`Note to team`} onSend={firstNote} />
                )}
              </div>
            </div>
          }
        >
          {(customer?.hasOlder || (teamId && team?.hasOlder)) && (
            <div className="flex justify-center pb-2">
              <button
                type="button"
                onClick={loadOlder}
                data-testid="ticket-load-older"
                className="rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Trans>Load older messages</Trans>
              </button>
            </div>
          )}
          <div style={{ ...columns, rowGap: 12 }} data-testid="ticket-timeline">
            <ConversationView {...props} embed={customerEmbed} />
            {teamId && <ConversationView key={teamId} conversationId={teamId} embed={teamEmbed} />}
            {!narrow &&
              timeline.teamRuns.map(({ row, count }) => (
                <div
                  key={`notes-${row}`}
                  style={{ gridColumn: 1, gridRow: row }}
                  className="flex items-center gap-2 self-start px-4 pt-3 text-[11px] text-muted-foreground"
                  data-testid="ticket-notes-marker"
                >
                  <span className="flex-1 border-t border-dashed border-border" />
                  <Trans>
                    {count} team {count === 1 ? 'note' : 'notes'} · not shown to {asker}
                  </Trans>
                </div>
              ))}
            {sent.map((item) => {
              const row = timeline.rowOf.get(timelineKey('customer', item.key));
              return row ? (
                <div
                  key={`sent-${item.key}`}
                  style={{ gridColumn: 2, gridRow: row }}
                  className="flex items-center gap-2 self-start px-4 pt-3 text-[11px] text-muted-foreground"
                  data-testid="ticket-sent-marker"
                >
                  <Trans>← sent to {asker}</Trans>
                  <span className="flex-1 border-t border-dashed border-border" />
                </div>
              ) : null;
            })}
            {noNotes && shown('team') && (
              <p
                style={{ gridColumn: columnOf('team'), gridRow: 1 }}
                className="self-start px-4 text-sm text-muted-foreground"
                data-testid="ticket-team-empty"
              >
                <Trans>
                  No team notes yet. Ask a teammate or keep a note about this ticket — it stays between the people who
                  answer this help desk.
                </Trans>
              </p>
            )}
          </div>
        </LatestScroll>
        {!narrow && (
          <div
            role="separator"
            aria-orientation="vertical"
            title={t`Drag to resize the two sides`}
            onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
            onPointerMove={drag}
            className="group absolute inset-y-0 z-10 flex w-3 -translate-x-1/2 cursor-col-resize touch-none items-center justify-center"
            style={{ insetInlineStart: `${split}%` }}
            data-testid="ticket-gutter"
          >
            <span className="absolute inset-y-0 w-px bg-border group-hover:bg-primary/60" />
            <span className="relative flex h-10 w-3 items-center justify-center rounded-sm border border-border bg-background text-muted-foreground group-hover:text-foreground">
              <GripVertical className="h-3 w-3" />
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
