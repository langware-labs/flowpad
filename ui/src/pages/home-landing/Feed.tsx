import { Conversation, FeedEntry, QueryRequest, type ConversationParticipant } from '@sdk';
import { useAuth } from '@sdk/react/hooks';
import { Button } from '@src/components/ui/button';
import { ShareToConversationDialog } from '@src/components/share-to-conversation/ShareToConversationDialog';
import { feedEntryShareSource } from '@src/hooks/share-sources';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useFeedMutations } from '@src/hooks/use-feed-mutations';
import { useCallback, useMemo, useState } from 'react';

const TRIM = 220;

/** Format a feed entry's `created_date` (ISO string or Date) as a local date+time (empty if absent). */
function formatRecorded(value?: string | Date): string {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

interface FeedEntryCardProps {
  entry: FeedEntry;
  busy: boolean;
  onDismiss: (entry: FeedEntry) => void;
  onSend: (entry: FeedEntry) => void;
}

function FeedEntryCard({ entry, busy, onDismiss, onSend }: FeedEntryCardProps) {
  const [expanded, setExpanded] = useState(false);
  const suggest = entry.messageSuggest;
  const header = suggest?.text ?? 'Flowpad diagnostics';
  const body = suggest?.message_text ?? '';
  const isLong = body.length > TRIM;
  const shown = expanded || !isLong ? body : `${body.slice(0, TRIM).trimEnd()}…`;
  const recorded = formatRecorded(entry.created_date);

  return (
    <div className="rounded-lg border bg-muted/40 px-3 py-2 text-left">
      <p className="text-sm font-medium">{header}</p>
      {recorded && (
        <p className="mt-0.5 text-[11px] text-muted-foreground">{recorded}</p>
      )}
      {body && (
        <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{shown}</p>
      )}
      {isLong && (
        <button
          type="button"
          className="mt-1 text-xs text-primary hover:underline"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
      <div className="mt-2 flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => onDismiss(entry)}
        >
          Dismiss
        </Button>
        <Button type="button" size="sm" disabled={busy} onClick={() => onSend(entry)}>
          Send to Support
        </Button>
      </div>
    </div>
  );
}

/**
 * Home-landing Feed: lists `new` FeedEntry items under the Join/Start buttons.
 * Each entry summarizes a `flow diagnose` run; Dismiss hides it, Send to Support
 * opens the unified share dialog with the report text pre-filled as the note
 * and the suggested support conversation pre-selected (via its participants).
 * The entry is dismissed only after the share actually goes out.
 */
export function Feed() {
  const request = useMemo(() => new QueryRequest({ type: FeedEntry.type }), []);
  const { data: entries = [], refetch } = useEntitiesQuery<FeedEntry>(request);
  const { cloudUser } = useAuth();
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
  const { dismiss, markSentToSupport } = useFeedMutations({ refetch: refetchVoid });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [shareEntry, setShareEntry] = useState<FeedEntry | null>(null);
  const [shareParticipants, setShareParticipants] = useState<ConversationParticipant[]>([]);

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

  const handleSend = useCallback(
    async (entry: FeedEntry) => {
      setBusyId(entry.id ?? null);
      try {
        // Seed the dialog's contact picker from the suggested support
        // conversation's roster so that conversation is pre-selected.
        let participants: ConversationParticipant[] = [];
        const convId = entry.messageSuggest?.conversation_id;
        if (convId) {
          const conv = await Conversation.getById<Conversation>(convId).catch(() => null);
          participants = (conv?.participants ?? []).filter(
            (p) => !cloudUser?.id || p.user_id !== cloudUser.id,
          );
        }
        setShareParticipants(participants);
        setShareEntry(entry);
      } finally {
        setBusyId(null);
      }
    },
    [cloudUser?.id],
  );

  const shareSource = useMemo(
    () =>
      shareEntry
        ? feedEntryShareSource({
            label: shareEntry.messageSuggest?.text ?? 'Flowpad diagnostics',
          })
        : null,
    [shareEntry],
  );

  if (!newEntries.length && !shareEntry) return null;

  return (
    <div className="w-full max-w-3xl flex flex-col gap-2">
      {newEntries.map((entry) => (
        <FeedEntryCard
          key={entry.id}
          entry={entry}
          busy={busyId === entry.id}
          onDismiss={(e) => void handleDismiss(e)}
          onSend={(e) => void handleSend(e)}
        />
      ))}
      {shareEntry && shareSource && (
        <ShareToConversationDialog
          open
          onClose={() => setShareEntry(null)}
          source={shareSource}
          defaultNote={shareEntry.messageSuggest?.message_text ?? ''}
          initialParticipants={shareParticipants}
          onShared={(convId) => void markSentToSupport(shareEntry, convId)}
        />
      )}
    </div>
  );
}
