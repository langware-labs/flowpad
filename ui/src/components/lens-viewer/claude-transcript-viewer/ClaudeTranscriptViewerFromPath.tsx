import { useMemo } from 'react';
import { Loader2 } from 'lucide-react';

import { useTranscript } from '@src/hooks/use-transcript';
import { AgentTranscript } from '@sdk';

import { ClaudeTranscriptViewer } from './ClaudeTranscriptViewer';

interface Props {
  /** Absolute filesystem path to the Claude session JSONL. */
  path: string;
  selectedEntryId?: string;
  selectedTimestamp?: string;
}

/**
 * Bridges the new path-based URL form (`/dock/lens/claude/transcript/<absPath>`)
 * to the legacy ClaudeTranscriptViewer renderer. Steps:
 *   1. Fetch via the worker-agnostic `/api/v1/transcripts/claude?path=...`.
 *   2. Adapt `GenericEntry[]` → legacy `ParsedTranscript` shape.
 *   3. Hand to `ClaudeTranscriptViewer` via its `externalTranscript` prop.
 *
 * The renderer is unchanged — same filters / scroll-clock / info modal /
 * cache badges as the legacy URL form. The view is byte-for-byte the same.
 */
export function ClaudeTranscriptViewerFromPath({ path, selectedEntryId, selectedTimestamp }: Props) {
  const { data, isLoading, error } = useTranscript({ workerType: 'claude', path });

  const transcript = useMemo(
    () => (data ? AgentTranscript.genericToLegacyTranscript(data) : null),
    [data],
  );

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground" data-testid="transcript-loading">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading transcript…
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6" data-testid="transcript-error">
        <div className="max-w-md text-center">
          <p className="text-sm font-medium text-destructive">Failed to load transcript</p>
          <p className="mt-1 break-all text-xs text-muted-foreground">{error.message}</p>
          <p className="mt-2 text-xs text-muted-foreground">{path}</p>
        </div>
      </div>
    );
  }
  if (!transcript) return null;

  return (
    <ClaudeTranscriptViewer
      projectEncodedName=""
      sessionId={transcript.sessionId ?? ''}
      selectedEntryId={selectedEntryId}
      selectedTimestamp={selectedTimestamp}
      externalTranscript={transcript}
      externalPath={path}
    />
  );
}
