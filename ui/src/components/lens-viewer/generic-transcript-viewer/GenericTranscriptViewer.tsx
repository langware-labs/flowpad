import { useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import { AgentTranscript } from '@sdk';
import { useTranscript, type WorkerType } from '@src/hooks/use-transcript';
import { ViewModeToggle } from '../shared/ViewModeToggle';
import { useTranscriptMode } from '../shared/use-transcript-mode';
import { formatTime } from '../shared/format-utils';
import { GenericTranscriptStats } from './GenericTranscriptStats';
import { EntryRow } from './EntryRow';
import { ClaudeTranscriptViewer } from '../claude-transcript-viewer';

interface Props {
  workerType: WorkerType;
  /** Absolute filesystem path to the JSONL transcript. */
  path: string;
}

const CHAT_KINDS = new Set(['user_message', 'assistant_message', 'tool_use', 'tool_result', 'summary']);

/**
 * Worker-agnostic transcript viewer.
 *
 * Reads typed entries via `useTranscript()` and dispatches each to its
 * `EntryRow` renderer. Two view modes:
 *   - chat: user/assistant/tool/summary only (the conversational stream)
 *   - transcript: every entry, including system/meta/token_usage rows.
 *
 * v1 has no per-tool / per-role filter UI or search — those features will
 * be added by the gap-detection loop as real sessions surface the need.
 */
export function GenericTranscriptViewer({ workerType, path }: Props) {
  const { data, isLoading, error } = useTranscript({ workerType, path });
  const [viewMode, setViewMode] = useTranscriptMode();

  // For Claude, adapt the generic shape back to the legacy `ParsedTranscript`
  // and let the rich `ClaudeTranscriptViewer` render it. Same renderer the
  // legacy URL form uses — so the view is identical to before, just sourced
  // from the worker-agnostic API. Codex falls through to the simpler list.
  const claudeTranscript = useMemo(() => {
    if (workerType !== 'claude' || !data) return null;
    return AgentTranscript.genericToLegacyTranscript(data);
  }, [workerType, data]);

  const visibleEntries = useMemo(() => {
    if (!data) return [];
    if (viewMode === 'chat') {
      return data.entries.filter((e) => CHAT_KINDS.has(e.kind));
    }
    return data.entries;
  }, [data, viewMode]);

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
  if (!data) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground" data-testid="transcript-empty">
        No transcript loaded.
      </div>
    );
  }

  // Claude → rich legacy renderer with adapted entries.
  if (claudeTranscript) {
    return (
      <ClaudeTranscriptViewer
        projectEncodedName=""
        sessionId={claudeTranscript.sessionId ?? ''}
        externalTranscript={claudeTranscript}
        externalPath={path}
      />
    );
  }

  return (
    <div className="flex h-full flex-col" data-testid="generic-transcript-viewer">
      <div className="flex items-center justify-between border-b border-border bg-background px-3 py-1.5">
        <span className="text-xs text-muted-foreground">{path}</span>
        <ViewModeToggle mode={viewMode} onChange={setViewMode} />
      </div>
      <GenericTranscriptStats data={data} />
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {visibleEntries.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No entries to show in {viewMode} mode.
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {visibleEntries.map((e) => (
              <li key={e.id} className="flex items-start gap-2">
                <span className="mt-0.5 w-16 flex-shrink-0 font-mono text-[10px] text-muted-foreground">
                  {formatTime(e.timestamp)}
                </span>
                <div className="min-w-0 flex-1">
                  <EntryRow entry={e} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
