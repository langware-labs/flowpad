import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Archive, CheckSquare, Inbox as InboxIcon, MailPlus, RefreshCw, Trash2 } from 'lucide-react';
import {
  Conversation,
  FlowMessage,
  QueryRequest,
  Task,
  TypeId,
  acceptInvitation,
  archiveAllConversations,
  archiveConversation,
  deleteArchivedConversations,
  fetchConversations,
} from '@sdk';
import { useEntitiesQuery, useEntity } from '@src/hooks/entity-hooks';
import { Button } from '@src/components/ui/button';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { useInboxStore } from '@src/store/use-inbox-store';
import { formatTimeAgo } from '@src/components/project-activity-strip/project-activity-utils';
import {
  updateMessage,
  bulkUpdateMessages,
} from './inbox-api';

// ── Time formatter (Gmail-style) ────────────────────────────────────────────
// today → "12:34 PM"  ·  this year → "Apr 28"  ·  older → locale date
function formatGmailTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString();
}

// ── Conversation list row (Gmail thread row) ────────────────────────────────
// Single line: [sender(s)] [subject — snippet…] [time]
// Click anywhere on the row opens the conversation via its dockPointer.

type InboxViewMode = 'inbox' | 'unread' | 'archived';

interface ConversationListRowProps {
  conv: Conversation;
  isFocused: boolean;
  /** Active inbox view:
   *  - 'inbox'    → hide archived rows (default)
   *  - 'unread'   → show only non-archived rows whose latest FlowMessage is unread
   *  - 'archived' → show ONLY archived rows */
  viewMode: InboxViewMode;
  /** Conversation-level archive. Stamps ``Conversation.archived_at = now()``
   *  server-side; row auto-revives when a FlowMessage newer than the stamp
   *  arrives. */
  onArchive: (convId: string) => void;
  onToggleRead: (messageId: string, isRead: boolean) => void;
  /** Reports whether this row will actually render so the parent can decide
   *  whether to show the "No conversations" empty state. */
  onVisibilityChange: (convId: string, visible: boolean) => void;
  refSetter: (el: HTMLDivElement | null) => void;
}

function ConversationListRow({ conv, isFocused, viewMode, onArchive, onToggleRead, onVisibilityChange, refSetter }: ConversationListRowProps) {
  const { navigation } = useDockNavigation();
  const taskTypeId = useMemo(
    () => conv.firstContextOfType?.('task') ?? null,
    [conv],
  );
  const { data: task } = useEntity<Task>(taskTypeId);

  // For invitation rows the first message IS the only message; for regular
  // rows we want the latest message preview but still need to peek at the
  // first to detect ``kind === 'invitation'``.
  const pointers = conv.conversationMessageIds ?? [];
  const firstPtr = pointers[0];
  const lastPtr = pointers[pointers.length - 1];
  const firstTypeId = useMemo(
    () => (firstPtr?.id ? new TypeId(FlowMessage.type, firstPtr.id) : null),
    [firstPtr?.id],
  );
  const latestTypeId = useMemo(
    () => (lastPtr?.id ? new TypeId(FlowMessage.type, lastPtr.id) : null),
    [lastPtr?.id],
  );
  const { data: firstMessage } = useEntity<FlowMessage>(firstTypeId);
  const { data: latestMessage } = useEntity<FlowMessage>(latestTypeId);

  const isInvitationRow = firstMessage?.kind === 'invitation';
  const invitationTypeId = useMemo(
    () => firstMessage?.firstContextOfType?.('invitation') ?? null,
    [firstMessage],
  );
  const invitationId = invitationTypeId?.id ?? null;
  const [accepting, setAccepting] = useState(false);

  // Hide rule depends on view mode:
  //   - 'inbox'     → hide archived rows (default; archived_at && stamp ≥ latest ts)
  //   - 'archived'  → show ONLY archived rows; hide everything else
  // ``archived_at`` uses the pointer's ts so we don't race the async
  // FlowMessage fetch (the latestMessage entity arrives later than the
  // conversation entity that carries the pointer).
  const archivedAt = conv.archived_at ? new Date(conv.archived_at).getTime() : null;
  const latestPtrTime = lastPtr?.ts ? new Date(lastPtr.ts).getTime() : 0;
  const archivedActive =
    archivedAt !== null && !Number.isNaN(archivedAt) && latestPtrTime <= archivedAt;
  const inLoadingState = !!lastPtr && !latestMessage;
  // unread = latest message is_read=false (invitation rows count as unread
  // since they always carry an actionable CTA).
  const isUnreadRow = isInvitationRow ? true : (latestMessage ? !latestMessage.is_read : false);
  let isHidden: boolean;
  if (viewMode === 'archived') {
    isHidden = !archivedActive || inLoadingState;
  } else if (viewMode === 'unread') {
    isHidden = archivedActive || !isUnreadRow || inLoadingState;
  } else {
    isHidden = archivedActive || inLoadingState;
  }

  const convId = conv.id ?? '';
  // useLayoutEffect (not useEffect) so the parent's `visibleIds` state is
  // updated before the browser paints — otherwise a row that ends up visible
  // could briefly co-render with the "No conversations" empty state on the
  // first frame.
  useLayoutEffect(() => {
    if (!convId) return;
    onVisibilityChange(convId, !isHidden);
    return () => onVisibilityChange(convId, false);
  }, [convId, isHidden, onVisibilityChange]);

  if (isHidden) return null;

  const sender = isInvitationRow
    ? 'Invitation'
    : (latestMessage?.sender_name?.trim() || 'Unknown');
  const count = pointers.length;
  const subject = isInvitationRow
    ? 'You’ve been invited to a conversation'
    : (task?.displayName ?? 'Conversation');
  // ``FlowMessage.text`` is typed string but older rows in the local DB can
  // hold non-string payloads (object-shaped values from earlier schema
  // iterations); ``?.replace`` would TypeError on those. Coerce first.
  const rawText = isInvitationRow ? firstMessage?.text : latestMessage?.text;
  const snippet = String(rawText ?? '').replace(/\s+/g, ' ').trim();
  const time = formatGmailTime(conv.updated_date);
  const ago = formatTimeAgo(conv.updated_date);
  const isUnread = isUnreadRow;

  const handleClick = () => {
    if (isInvitationRow) return; // primary action is Accept
    if (!conv.id) return;
    navigation.openDock(DockPointer.forConversation(conv.id));
  };

  const handleAccept = async () => {
    if (!invitationId) return;
    setAccepting(true);
    try {
      await acceptInvitation({ invitation_id: invitationId });
    } catch (e) {
      console.error('[InboxView] acceptInvitation failed', e);
    } finally {
      setAccepting(false);
    }
  };

  return (
    <div
      ref={refSetter}
      data-testid="inbox-conversation-row"
      data-conversation-id={conv.id ?? ''}
      data-focused={isFocused ? 'true' : 'false'}
      data-unread={isUnread ? 'true' : 'false'}
      data-kind={isInvitationRow ? 'invitation' : 'user'}
      onClick={handleClick}
      className={`group relative flex h-9 ${
        isInvitationRow ? 'cursor-default' : 'cursor-pointer'
      } items-center gap-3 border-b border-border/40 px-3 text-sm transition-colors hover:bg-accent/40 hover:shadow-sm ${
        isFocused ? 'bg-primary/10' : ''
      } ${isUnread ? 'bg-background' : 'bg-muted/20'} ${
        isInvitationRow ? 'border-l-2 border-l-violet-500/60' : ''
      }`}
    >
      <span
        data-testid="inbox-row-sender"
        className={`flex w-44 shrink-0 items-center gap-1 truncate ${isUnread ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}
      >
        {isInvitationRow && (
          <MailPlus className="h-3.5 w-3.5 flex-shrink-0 text-violet-500" aria-label="invitation" />
        )}
        <span className="truncate">{sender}</span>
        {!isInvitationRow && count > 1 && (
          <span className="ml-1 font-normal text-muted-foreground">({count})</span>
        )}
      </span>
      <span className="min-w-0 flex-1 truncate" data-testid="inbox-row-subject-line">
        <span className={isUnread ? 'font-semibold text-foreground' : 'text-foreground/80'}>{subject}</span>
        {snippet && (
          <>
            <span className="mx-1 text-muted-foreground">—</span>
            <span className="text-muted-foreground">{snippet}</span>
          </>
        )}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground transition-opacity group-hover:opacity-0">
        {time}
        {ago && <span className="ml-1.5 text-muted-foreground/70">· {ago}</span>}
      </span>
      <div
        className="absolute right-2 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100"
        onClick={(e) => e.stopPropagation()}
      >
        {isInvitationRow ? (
          <button
            type="button"
            onClick={() => void handleAccept()}
            disabled={accepting || !invitationId}
            className="rounded bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            data-testid="inbox-accept-invitation-button"
          >
            {accepting ? 'Accepting…' : 'Accept'}
          </button>
        ) : (
          <>
            <button
              className="rounded p-1 hover:bg-muted"
              title={isUnread ? 'Mark read' : 'Mark unread'}
              onClick={() => latestMessage?.id && onToggleRead(latestMessage.id, isUnread)}
            >
              <CheckSquare className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
            <button
              className="rounded p-1 hover:bg-destructive/10"
              title="Archive conversation"
              onClick={() => conv.id && onArchive(conv.id)}
            >
              <Archive className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ── InboxView ───────────────────────────────────────────────────────────────

export function InboxView() {
  const [fetching, setFetching] = useState(false);
  // 'inbox' (default) shows active conversations; 'archived' shows only
  // rows whose ``archived_at`` is set and not yet revived by newer activity.
  // "Delete all" is gated behind the 'archived' view — a destructive op only
  // exposed once the user has explicitly archived rows.
  const [viewMode, setViewMode] = useState<InboxViewMode>('inbox');
  // Set of conv ids whose row currently chose to render. Driven by row-level
  // `onVisibilityChange` callbacks so the header badge and empty-state both
  // reflect exactly what the user sees (rows hide themselves when their latest
  // FlowMessage is archived or hasn't materialised yet).
  const [visibleIds, setVisibleIds] = useState<Set<string>>(new Set());
  const rowRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const { navigation, currentDock } = useDockNavigation();
  const { setUnreadCount } = useInboxStore();

  const request = useMemo(() => new QueryRequest({ type: Conversation.type }), []);
  const { data: conversations = [], refetch, isLoading } = useEntitiesQuery<Conversation>(request);

  const sorted = useMemo(() => {
    const list = [...conversations];
    list.sort((a, b) => {
      const ta = a.updated_date ? new Date(a.updated_date).getTime() : 0;
      const tb = b.updated_date ? new Date(b.updated_date).getTime() : 0;
      return tb - ta;
    });
    return list;
  }, [conversations]);

  const handleRowVisibility = useCallback((convId: string, visible: boolean) => {
    setVisibleIds((prev) => {
      const has = prev.has(convId);
      if (visible === has) return prev;
      const next = new Set(prev);
      if (visible) next.add(convId);
      else next.delete(convId);
      return next;
    });
  }, []);

  const visibleCount = visibleIds.size;

  // Unread badge for the sidebar pip is driven server-side (`inbox-list`
  // returns received non-archived FMs only). Decoupled from the visible-row
  // count above because that one needs to follow self-sent rows the server
  // filter excludes.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { listInboxMessages } = await import('./inbox-api');
        const msgs = await listInboxMessages();
        if (cancelled) return;
        setUnreadCount(msgs.filter((m) => !m.is_read).length);
      } catch {
        // non-fatal — leave the badge as-is.
      }
    })();
    return () => { cancelled = true; };
  }, [setUnreadCount, conversations.length]);

  // On inbox mount: pull any pending bundles from the hub so conversations
  // whose pointer-list references not-yet-materialised FlowMessages don't
  // 404 in the rendered rows. Fire-and-forget — the entity-update channel
  // will refresh rows once the FMs land locally.
  useEffect(() => {
    void fetchConversations().then(() => refetch()).catch(() => {});
    // Run once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  const handleRefresh = useCallback(async () => {
    setFetching(true);
    try {
      await fetchConversations();
      void refetch();
    } finally {
      setFetching(false);
    }
  }, [refetch]);

  const handleArchive = useCallback(async (convId: string) => {
    await archiveConversation({ conversation_id: convId });
    void refetch();
  }, [refetch]);

  const handleToggleRead = useCallback(async (id: string, isRead: boolean) => {
    await updateMessage(id, { is_read: isRead });
    void refetch();
  }, [refetch]);

  const handleMarkAllRead = useCallback(async () => {
    await bulkUpdateMessages({ is_read: true });
    setUnreadCount(0);
    void refetch();
  }, [refetch, setUnreadCount]);

  const handleArchiveAll = useCallback(async () => {
    // Conversation-level archive — O(threads), not O(messages). Includes
    // empties (zero-message conversations) since archive is now a property
    // of the conversation itself, independent of FlowMessage state.
    await archiveAllConversations();
    void refetch();
  }, [refetch]);

  const handleDeleteArchived = useCallback(async () => {
    // Hard delete — only callable from the 'archived' view, where the user
    // has explicitly archived these rows. Server side already filters to
    // ``archived_at IS NOT NULL`` so this is scoped strictly to the bucket.
    await deleteArchivedConversations();
    void refetch();
  }, [refetch]);

  const setView = useCallback((next: InboxViewMode) => {
    setViewMode((cur) => {
      if (cur === next) return cur;
      // Visible-ids tracks the previous mode's rows; reset so the count
      // badge doesn't flash stale during the swap.
      setVisibleIds(new Set());
      return next;
    });
  }, []);


  const inArchivedView = viewMode === 'archived';
  const inUnreadView = viewMode === 'unread';

  // Segmented view pill — Inbox | Unread | Archived. Active mode is filled,
  // inactive is ghost. Count badge sits inside the active pill so it
  // reflects exactly what the user is looking at.
  const renderViewPill = (mode: InboxViewMode, label: string, Icon: typeof InboxIcon) => {
    const active = viewMode === mode;
    return (
      <button
        type="button"
        onClick={() => setView(mode)}
        className={`flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors ${
          active
            ? 'bg-background text-foreground shadow-sm'
            : 'text-muted-foreground hover:text-foreground'
        }`}
        data-testid={`inbox-view-${mode}`}
        aria-pressed={active}
      >
        <Icon className="h-3.5 w-3.5" />
        <span>{label}</span>
        {active && visibleCount > 0 && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {visibleCount}
          </span>
        )}
      </button>
    );
  };

  // List mode
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-1.5">
        {/* LEFT — view selector */}
        <div
          className="flex items-center gap-0.5 rounded-md bg-muted/40 p-0.5"
          role="tablist"
          aria-label="Inbox view"
          data-testid="inbox-view-bar"
        >
          {renderViewPill('inbox', 'Inbox', InboxIcon)}
          {renderViewPill('unread', 'Unread', MailPlus)}
          {renderViewPill('archived', 'Archived', Archive)}
        </div>
        {/* RIGHT — actions for the current view */}
        <div className="flex items-center gap-1" data-testid="inbox-action-bar">
          {!inArchivedView && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => void handleMarkAllRead()}
              disabled={isLoading || visibleCount === 0}
            >
              Mark all read
            </Button>
          )}
          {/* Archive all archives every conversation regardless of read state;
              hide it in the Archived view where it makes no sense. */}
          {!inArchivedView && !inUnreadView && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => void handleArchiveAll()}
              disabled={isLoading || visibleCount === 0}
              data-testid="inbox-archive-all-button"
            >
              Archive all
            </Button>
          )}
          {inArchivedView && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => void handleDeleteArchived()}
              disabled={isLoading || visibleCount === 0}
              data-testid="inbox-delete-archived-button"
            >
              <Trash2 className="mr-1 h-3.5 w-3.5" />
              Delete all
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => void handleRefresh()}
            disabled={fetching}
            title="Fetch new messages from hub"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${fetching ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">Loading…</div>
        )}

        {!isLoading && visibleCount === 0 && (
          <div className="flex h-48 flex-col items-center justify-center gap-3 text-muted-foreground">
            <span className="text-sm">
              {inArchivedView ? 'No archived conversations'
                : inUnreadView ? 'No unread conversations'
                : 'No conversations'}
            </span>
            {!inArchivedView && (
              <Button variant="outline" size="sm" onClick={() => void handleRefresh()} disabled={fetching}>
                <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${fetching ? 'animate-spin' : ''}`} />
                Check for new messages
              </Button>
            )}
          </div>
        )}

        {!isLoading &&
          sorted.map((conv) => (
            <ConversationListRow
              key={conv.id ?? ''}
              conv={conv}
              isFocused={false}
              viewMode={viewMode}
              onArchive={handleArchive}
              onToggleRead={handleToggleRead}
              onVisibilityChange={handleRowVisibility}
              refSetter={(el) => {
                if (conv.id) rowRefs.current.set(conv.id, el);
              }}
            />
          ))}
      </div>
    </div>
  );
}
