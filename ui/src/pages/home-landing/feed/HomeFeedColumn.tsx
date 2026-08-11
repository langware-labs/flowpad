import {
  FeedEntry,
  MessageSuggest,
  QueryRequest,
  UserNote,
  forwardDiagnosis,
  sendDiagnosisEmailReport,
  type EntityFeedData,
} from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useFeedMutations } from '@src/hooks/use-feed-mutations';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { EyeOff, MessageSquarePlus, Rss, Send } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { FeedEntryCard } from './FeedEntryCard';
import { ErrorBoundary } from '@src/components/error-boundary/error-boundary';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Textarea } from '@src/components/ui/textarea';

/** Bulk clear only earns its header space once the list is long enough to be a chore. */
const DISMISS_ALL_MIN_ENTRIES = 5;

export function HomeFeedColumn() {
  const { t } = useLingui();
  const request = useMemo(() => new QueryRequest({ type: FeedEntry.type }), []);
  const { data: entries = [], refetch } = useEntitiesQuery<FeedEntry>(request);
  const newEntries = useMemo(
    () =>
      entries
        .filter((entry) => entry.feed_status === 'new')
        .sort((a, b) => new Date(b.created_date ?? 0).getTime() - new Date(a.created_date ?? 0).getTime()),
    [entries],
  );
  const refetchVoid = useCallback(async () => {
    await refetch();
  }, [refetch]);
  const { dismiss, dismissAll } = useFeedMutations({ refetch: refetchVoid });
  const { navigation } = useDockNavigation();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sendError, setSendError] = useState<{ entryId: string; message: string } | null>(null);
  // Entry ids whose "Report issue" email already went out this session — the card
  // shows a disabled "✓ Reported" instead, so a re-click can't email a duplicate.
  const [reportedIds, setReportedIds] = useState<ReadonlySet<string>>(new Set());
  const [commentOpen, setCommentOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [creatingNote, setCreatingNote] = useState(false);
  const [dismissingAll, setDismissingAll] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const handleDismiss = useCallback(
    async (entry: FeedEntry) => {
      setBusyId(entry.id ?? null);
      try {
        await dismiss(entry);
      } finally {
        setBusyId(null);
      }
    },
    [dismiss],
  );

  const handleDismissAll = async () => {
    setDismissingAll(true);
    try {
      await dismissAll(newEntries);
    } finally {
      setDismissingAll(false);
    }
  };

  // "Report issue" — email the diagnosis to the Flowpad team (via the backend
  // `report` action → hub → SendGrid). Does NOT dismiss the card (only eye-off does).
  const handleReportIssue = useCallback(async (entry: FeedEntry, suggest: MessageSuggest) => {
    if (!suggest.diagnosis_id) return;
    setBusyId(entry.id ?? null);
    setSendError(null);
    try {
      await sendDiagnosisEmailReport(suggest.diagnosis_id);
      if (entry.id) {
        setReportedIds((prev) => new Set(prev).add(entry.id));
      }
    } catch (err: unknown) {
      setSendError({
        entryId: entry.id ?? '',
        message: err instanceof Error ? err.message : t`Failed to send report`,
      });
    } finally {
      setBusyId(null);
    }
  }, []);

  // "Forward" — attach the diagnosis entity into the chosen conversation.
  const handleForwardMessageSuggest = useCallback(
    async (entry: FeedEntry, suggest: MessageSuggest, conversationId: string) => {
      if (!suggest.diagnosis_id) return;
      setBusyId(entry.id ?? null);
      setSendError(null);
      try {
        await forwardDiagnosis(conversationId, suggest.diagnosis_id);
        // Open the conversation we forwarded into. (Forward/Report never dismiss the
        // card — only the eye-off button does.)
        navigation.openDock(DockPointer.forConversation(conversationId));
      } catch (err: unknown) {
        setSendError({
          entryId: entry.id ?? '',
          message: err instanceof Error ? err.message : t`Failed to send report`,
        });
      } finally {
        setBusyId(null);
      }
    },
    [navigation],
  );

  const handleCreateNote = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const content = noteDraft.trim();
      if (!content || creatingNote) return;

      setCreatingNote(true);
      setCreateError(null);
      try {
        const note = await new UserNote({ content }).save([]);
        await new FeedEntry<EntityFeedData>({
          feed_status: 'new',
          data: { type_id: note.typeId.toString() },
        }).save([]);
        setNoteDraft('');
        setCommentOpen(false);
        await refetchVoid();
      } catch (err: unknown) {
        setCreateError(err instanceof Error ? err.message : t`Failed to add comment`);
      } finally {
        setCreatingNote(false);
      }
    },
    [creatingNote, noteDraft, refetchVoid],
  );

  const canCreateNote = noteDraft.trim().length > 0 && !creatingNote;
  const handleCommentOpenChange = useCallback(
    (open: boolean) => {
      if (creatingNote) return;
      setCommentOpen(open);
      if (!open) {
        setCreateError(null);
      }
    },
    [creatingNote],
  );

  return (
    <div className="flex h-full min-h-0 w-72 shrink-0 flex-col gap-2">
      <div aria-hidden className="h-9 shrink-0" />
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card"
        data-testid="home-feed-column"
      >
        <div className="flex items-center justify-between border-b border-border p-3">
          <div className="flex items-center gap-2">
            <Rss className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">
              <Trans>Feed</Trans>
            </h3>
            {newEntries.length > 0 && (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {newEntries.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {newEntries.length > DISMISS_ALL_MIN_ENTRIES && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 shrink-0 px-2 text-xs text-muted-foreground"
                disabled={dismissingAll}
                onClick={() => void handleDismissAll()}
                data-testid="home-feed-dismiss-all"
              >
                <EyeOff className="mr-1 h-3.5 w-3.5" />
                <Trans>Dismiss all</Trans>
              </Button>
            )}
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-7 w-7 shrink-0"
              title={t`Add comment`}
              aria-label={t`Add comment`}
              onClick={() => setCommentOpen(true)}
            >
              <MessageSquarePlus className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {newEntries.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            <Trans>No feed items</Trans>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain p-2">
            {/* One boundary per card: a card that throws while rendering degrades to
                <InvalidFeedItem> instead of reaching the router's root errorElement,
                which would replace the whole app (FLOWPAD-1974). */}
            {newEntries.map((entry) => (
              <ErrorBoundary
                key={entry.id}
                label={`feed-card:${entry.id}`}
                fallback={<InvalidFeedItem busy={busyId === entry.id} onDismiss={() => void handleDismiss(entry)} />}
              >
                <FeedEntryCard
                  entry={entry}
                  busy={busyId === entry.id}
                  error={sendError?.entryId === entry.id ? sendError.message : undefined}
                  onDismiss={(item) => void handleDismiss(item)}
                  onReportIssue={(item, suggest) => void handleReportIssue(item, suggest)}
                  reported={!!entry.id && reportedIds.has(entry.id)}
                  onForwardMessageSuggest={(item, suggest, conversationId) =>
                    void handleForwardMessageSuggest(item, suggest, conversationId)
                  }
                />
              </ErrorBoundary>
            ))}
          </div>
        )}
      </div>

      <Dialog open={commentOpen} onOpenChange={handleCommentOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              <Trans>Add comment</Trans>
            </DialogTitle>
          </DialogHeader>

          <form className="flex flex-col gap-3" onSubmit={(event) => void handleCreateNote(event)}>
            <Textarea
              aria-label={t`Feed comment`}
              placeholder={t`Add comment...`}
              value={noteDraft}
              disabled={creatingNote}
              onChange={(event) => setNoteDraft(event.target.value)}
              className="min-h-28 resize-none"
              autoFocus
            />
            <div className="min-h-4">{createError && <p className="text-xs text-destructive">{createError}</p>}</div>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={creatingNote}>
                  <Trans>Cancel</Trans>
                </Button>
              </DialogClose>
              <Button type="submit" disabled={!canCreateNote}>
                <Send className="mr-2 h-3.5 w-3.5" />
                <Trans>Add</Trans>
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * What a feed card degrades to when it throws while rendering. Deliberately dumb
 * — no entity reads, nothing that could throw a second time inside the boundary's
 * own fallback. The entry id is already in the boundary's log label.
 *
 * Carries its own hide button rather than `FeedEntryFrame`: a permanently broken
 * entry must still be clearable, and the frame reads `feedData` off the entry —
 * exactly the kind of work this fallback exists to avoid.
 */
const InvalidFeedItem = ({ busy, onDismiss }: { busy: boolean; onDismiss: () => void }) => {
  const { t } = useLingui();
  const hideLabel = t`Hide feed entry`;

  useEffect(() => {
    console.error('[feed] error while displaying the suggestion');
  }, []);

  return (
    <div className="flex items-start justify-between gap-2 rounded border border-border bg-muted/40 px-2.5 py-2">
      <p className="min-w-0 text-xs leading-snug text-muted-foreground">
        <Trans>Error while displaying the suggestion, contact support</Trans>
      </p>
      <button
        type="button"
        aria-label={hideLabel}
        title={hideLabel}
        disabled={busy}
        onClick={onDismiss}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
      >
        <EyeOff className="h-3.5 w-3.5" />
      </button>
    </div>
  );
};
