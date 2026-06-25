import {
  FeedEntry,
  MessageSuggest,
  QueryRequest,
  UserNote,
  sendDiagnosisReport,
  sendDiagnosisEmailReport,
  type EntityFeedData,
} from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useFeedMutations } from '@src/hooks/use-feed-mutations';
import { MessageSquarePlus, Rss, Send } from 'lucide-react';
import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { FeedEntryCard } from './FeedEntryCard';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Textarea } from '@src/components/ui/textarea';

export function HomeFeedColumn() {
  const request = useMemo(() => new QueryRequest({ type: FeedEntry.type }), []);
  const { data: entries = [], refetch } = useEntitiesQuery<FeedEntry>(request);
  const newEntries = useMemo(
    () =>
      entries
        .filter((entry) => entry.feed_status === 'new')
        .sort(
          (a, b) =>
            new Date(b.created_date ?? 0).getTime() - new Date(a.created_date ?? 0).getTime(),
        ),
    [entries],
  );
  const refetchVoid = useCallback(async () => {
    await refetch();
  }, [refetch]);
  const { dismiss } = useFeedMutations({ refetch: refetchVoid });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sendError, setSendError] = useState<{ entryId: string; message: string } | null>(null);
  const [commentOpen, setCommentOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [creatingNote, setCreatingNote] = useState(false);
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

  // "Report issue" — email the diagnosis to the Flowpad team (via the backend
  // `report` action → hub → SendGrid). Does NOT dismiss the card (only eye-off does).
  const handleReportIssue = useCallback(
    async (entry: FeedEntry, suggest: MessageSuggest) => {
      if (!suggest.diagnosis_id) return;
      setBusyId(entry.id ?? null);
      setSendError(null);
      try {
        await sendDiagnosisEmailReport(suggest.diagnosis_id);
      } catch (err: unknown) {
        setSendError({
          entryId: entry.id ?? '',
          message: err instanceof Error ? err.message : 'Failed to send report',
        });
      } finally {
        setBusyId(null);
      }
    },
    [],
  );

  // "Forward" — post the formatted report into the chosen conversation.
  const handleForwardMessageSuggest = useCallback(
    async (entry: FeedEntry, suggest: MessageSuggest, conversationId: string) => {
      setBusyId(entry.id ?? null);
      setSendError(null);
      try {
        await sendDiagnosisReport(conversationId, {
          flowMessageId: suggest.flow_message_id ?? undefined,
          fallbackText: suggest.message_text ?? '',
        });
        // Report/Forward no longer dismiss the card — only the eye-off button does.
      } catch (err: unknown) {
        setSendError({
          entryId: entry.id ?? '',
          message: err instanceof Error ? err.message : 'Failed to send report',
        });
      } finally {
        setBusyId(null);
      }
    },
    [],
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
        setCreateError(err instanceof Error ? err.message : 'Failed to add comment');
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
    <div className="w-72 shrink-0 flex flex-col gap-2">
      <div aria-hidden className="h-9 shrink-0" />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card" data-testid="home-feed-column">
        <div className="flex items-center justify-between border-b border-border p-3">
          <div className="flex items-center gap-2">
            <Rss className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Feed</h3>
            {newEntries.length > 0 && (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {newEntries.length}
              </span>
            )}
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7 shrink-0"
            title="Add comment"
            aria-label="Add comment"
            onClick={() => setCommentOpen(true)}
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
          </Button>
        </div>

        {newEntries.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">No feed items</div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain p-2">
            {newEntries.map((entry) => (
              <FeedEntryCard
                key={entry.id}
                entry={entry}
                busy={busyId === entry.id}
                error={sendError?.entryId === entry.id ? sendError.message : undefined}
                onDismiss={(item) => void handleDismiss(item)}
                onReportIssue={(item, suggest) => void handleReportIssue(item, suggest)}
                onForwardMessageSuggest={(item, suggest, conversationId) =>
                  void handleForwardMessageSuggest(item, suggest, conversationId)
                }
              />
            ))}
          </div>
        )}
      </div>

      <Dialog open={commentOpen} onOpenChange={handleCommentOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add comment</DialogTitle>
          </DialogHeader>

          <form className="flex flex-col gap-3" onSubmit={(event) => void handleCreateNote(event)}>
            <Textarea
              aria-label="Feed comment"
              placeholder="Add comment..."
              value={noteDraft}
              disabled={creatingNote}
              onChange={(event) => setNoteDraft(event.target.value)}
              className="min-h-28 resize-none"
              autoFocus
            />
            <div className="min-h-4">
              {createError && (
                <p className="text-xs text-destructive">{createError}</p>
              )}
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={creatingNote}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={!canCreateNote}>
                <Send className="mr-2 h-3.5 w-3.5" />
                Add
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
