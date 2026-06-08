import { FeedEntry, QueryRequest } from '@sdk';
import { Button } from '@src/components/ui/button';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useFeedMutations } from '@src/hooks/use-feed-mutations';
import { useCallback, useMemo, useState } from 'react';

const TRIM = 220;

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

  return (
    <div className="rounded-lg border bg-muted/40 px-3 py-2 text-left">
      <p className="text-sm font-medium">{header}</p>
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
 * also reveals the linked support conversation in the Recent strip.
 */
export function Feed() {
  const request = useMemo(() => new QueryRequest({ type: FeedEntry.type }), []);
  const { data: entries = [], refetch } = useEntitiesQuery<FeedEntry>(request);
  const newEntries = useMemo(
    () => entries.filter((e) => e.feed_status === 'new'),
    [entries],
  );
  const refetchVoid = useCallback(async () => {
    await refetch();
  }, [refetch]);
  const { dismiss, sendToSupport } = useFeedMutations({ refetch: refetchVoid });
  const [busyId, setBusyId] = useState<string | null>(null);

  const run = useCallback(
    (fn: (entry: FeedEntry) => Promise<void>) => async (entry: FeedEntry) => {
      setBusyId(entry.id ?? null);
      try {
        await fn(entry);
      } finally {
        setBusyId(null);
      }
    },
    [],
  );

  if (!newEntries.length) return null;

  return (
    <div className="w-full max-w-3xl flex flex-col gap-2">
      {newEntries.map((entry) => (
        <FeedEntryCard
          key={entry.id}
          entry={entry}
          busy={busyId === entry.id}
          onDismiss={run(dismiss)}
          onSend={run(sendToSupport)}
        />
      ))}
    </div>
  );
}
