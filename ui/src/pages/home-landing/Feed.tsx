import { FeedEntry, QueryRequest } from '@sdk';
import { DiagnosisActionButtons } from '@src/components/diagnose/diagnosis-action-buttons';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useFeedMutations } from '@src/hooks/use-feed-mutations';
import { ChevronDown, ChevronRight, EyeOff } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

/** Format a feed entry's `created_date` (ISO string or Date) as a local date+time (empty if absent). */
function formatRecorded(value?: string | Date): string {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

interface FeedEntryCardProps {
  entry: FeedEntry;
  busy: boolean;
  error?: string;
  onDismiss: (entry: FeedEntry) => void;
  onReport: (entry: FeedEntry, conversationId: string) => void;
}

function FeedEntryCard({ entry, busy, error, onDismiss, onReport }: FeedEntryCardProps) {
  const [expanded, setExpanded] = useState(false);
  const suggest = entry.messageSuggest;
  const header = suggest?.text ?? 'Flowpad diagnostics';
  const body = suggest?.message_text ?? '';
  const expandable = body.length > 80 || body.includes('\n');
  const recorded = formatRecorded(entry.created_date);

  return (
    <div className="flex max-h-[60vh] flex-col rounded-lg border bg-muted/40 px-3 py-2 text-left">
      {/* Header row: title left, date/time top-right */}
      <div className="flex shrink-0 items-start justify-between gap-2">
        <p className="min-w-0 text-sm font-medium">{header}</p>
        {recorded && (
          <p className="shrink-0 text-[11px] text-muted-foreground">{recorded}</p>
        )}
      </div>

      {body &&
        (expanded ? (
          <div className="mt-1 flex min-h-0 flex-1 gap-1">
            {expandable && (
              <button
                type="button"
                aria-label="Collapse"
                className="mt-0.5 shrink-0 self-start text-muted-foreground hover:text-foreground"
                onClick={() => setExpanded(false)}
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              <p
                className="cursor-pointer whitespace-pre-wrap text-xs text-muted-foreground"
                onClick={() => expandable && setExpanded(false)}
              >
                {body}
              </p>
            </div>
          </div>
        ) : (
          <div className="mt-1 flex items-start gap-1">
            {expandable && (
              <button
                type="button"
                aria-label="Expand"
                className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => setExpanded(true)}
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            )}
            <div className="flex min-w-0 flex-1 items-center gap-1 text-xs text-muted-foreground">
              <span
                className={`truncate ${expandable ? 'cursor-pointer' : ''}`}
                title={body}
                onClick={() => expandable && setExpanded(true)}
              >
                {body}
              </span>
              {expandable && (
                <button
                  type="button"
                  className="shrink-0 text-primary hover:underline"
                  onClick={() => setExpanded(true)}
                >
                  show more
                </button>
              )}
            </div>
          </div>
        ))}

      {suggest?.conversation_id ? (
        // Issue card: full Report / Forward / Dismiss row pointing at the support conversation.
        <DiagnosisActionButtons
          suggestedConversationId={suggest.conversation_id}
          busy={busy}
          error={error}
          onDismiss={() => onDismiss(entry)}
          onReport={(conversationId) => onReport(entry, conversationId)}
        />
      ) : (
        // No-issue card: nothing to report — the summary above is the answer, so just Dismiss.
        <div className="mt-2 flex shrink-0 items-center gap-2">
          <button
            type="button"
            aria-label="Dismiss"
            title="Dismiss"
            disabled={busy}
            onClick={() => onDismiss(entry)}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <EyeOff className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Home-landing Feed: lists `new` FeedEntry items under the Join/Start buttons.
 * Each entry summarizes a `flow diagnose` run. Dismiss hides it; "Report issue"
 * sends the generated report into the suggested support conversation; "Forward"
 * opens a recent-conversation list (share-dialog-style rows) and clicking one
 * sends the same report there instead. Both paths are the single
 * `reportIssue(entry, conversationId)` mutation — the entry is dismissed only
 * after the message actually goes out.
 */
export function Feed() {
  const request = useMemo(() => new QueryRequest({ type: FeedEntry.type }), []);
  const { data: entries = [], refetch } = useEntitiesQuery<FeedEntry>(request);
  const newEntries = useMemo(
    () =>
      entries
        .filter((e) => e.feed_status === 'new')
        .sort(
          (a, b) =>
            new Date(b.created_date ?? 0).getTime() - new Date(a.created_date ?? 0).getTime(),
        ),
    [entries],
  );
  const refetchVoid = useCallback(async () => {
    await refetch();
  }, [refetch]);
  const { dismiss, reportIssue } = useFeedMutations({ refetch: refetchVoid });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sendError, setSendError] = useState<{ entryId: string; message: string } | null>(null);

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

  const handleReport = useCallback(
    async (entry: FeedEntry, conversationId: string) => {
      setBusyId(entry.id ?? null);
      setSendError(null);
      try {
        await reportIssue(entry, conversationId);
      } catch (err: unknown) {
        setSendError({
          entryId: entry.id ?? '',
          message: err instanceof Error ? err.message : 'Failed to send report',
        });
      } finally {
        setBusyId(null);
      }
    },
    [reportIssue],
  );

  if (!newEntries.length) return null;

  return (
    <div className="w-full max-w-3xl flex max-h-[60vh] flex-col gap-2 overflow-y-auto overscroll-contain">
      {newEntries.map((entry) => (
        <FeedEntryCard
          key={entry.id}
          entry={entry}
          busy={busyId === entry.id}
          error={sendError?.entryId === entry.id ? sendError.message : undefined}
          onDismiss={(e) => void handleDismiss(e)}
          onReport={(e, convId) => void handleReport(e, convId)}
        />
      ))}
    </div>
  );
}
