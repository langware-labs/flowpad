import { useCallback, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Trans } from '@lingui/react/macro';

import { useTranscript, type WorkerType } from '@src/hooks/use-transcript';
import { useIsAdvanced } from '@src/components/view-mode';
import { ChatEntryItem } from '@src/components/lens-viewer/shared/transcript-features/ChatEntryItem';
import { groupEntriesByTurn } from '@src/components/lens-viewer/shared/transcript-features/group-entries';
import type { UnifiedEntry } from '@src/components/lens-viewer/shared/transcript-features/types';

/**
 * Read-only chat rendering of a STAGED (not yet installed) worker transcript.
 *
 * A shared transcript is a `.jsonl` of parsed-out turns, so the generic
 * staged-file preview — which pipes any non-markdown file into a `<pre>` —
 * showed the reviewer a wall of raw JSON, the one shape that makes a transcript
 * unreadable. This renders the same turns the real viewer does, through the
 * same server parse (`useTranscript` by absolute path) and the same
 * `ChatEntryItem` rows.
 *
 * Deliberately NOT the full {@link TranscriptViewer}: that one owns tab naming,
 * URL anchoring (`transcript_entry_id`/`ts`) and the analyze-worker toolbar —
 * all of which are wrong for a modal preview of something the user hasn't
 * accepted yet. Chat turns only; the full viewer is what they get after install.
 */
export function StagedTranscriptPreview({ workerType, path }: { workerType: WorkerType; path: string }) {
  const { data, isLoading, error } = useTranscript({ workerType, path });
  const isAdvanced = useIsAdvanced();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const entries = useMemo<UnifiedEntry[]>(() => (data ? groupEntriesByTurn(data.entries) : []), [data]);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        <Trans>This transcript could not be read.</Trans>
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        <Trans>This transcript has no messages.</Trans>
      </div>
    );
  }

  return (
    <div className="divide-y divide-border rounded border border-border">
      {entries.map((entry) => (
        <ChatEntryItem
          key={entry.id}
          entry={entry}
          isExpanded={expanded.has(entry.id)}
          onToggle={() => toggle(entry.id)}
          isAdvanced={isAdvanced}
        />
      ))}
    </div>
  );
}
