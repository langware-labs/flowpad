import { AgenticProcess } from '@sdk';
import { useEffect, useMemo, useState } from 'react';
import type { PromptEntry } from './PromptIndexPanel';

export interface TranscriptPrompt {
  uuid: string;
  time: string;
  text: string;
}

export interface UsePromptsForProcessResult {
  transcriptPrompts: TranscriptPrompt[];
  promptEntries: PromptEntry[];
  isLoading: boolean;
}

/**
 * Loads the canonical user-prompt list for an AgenticProcess via
 * `transcript/prompts`, refreshing on `status` transitions (RUNNING → READY etc.)
 * which are a coarse signal that the JSONL transcript likely grew.
 *
 * Returns both shapes:
 *   - `transcriptPrompts`: raw `{ uuid, time, text }` triples, used by callers
 *     that join with terminal annotations to compute `absRow`.
 *   - `promptEntries`: read-only `PromptEntry[]` with `absRow: null`, suitable
 *     for surfaces with no live terminal (e.g. peek from HistoryModal).
 */
export function usePromptsForProcess(
  process: AgenticProcess | null,
): UsePromptsForProcessResult {
  const [transcriptPrompts, setTranscriptPrompts] = useState<TranscriptPrompt[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!process) {
      setTranscriptPrompts([]);
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    const fetchPrompts = async () => {
      setIsLoading(true);
      try {
        const ums = await process.getPrompts();
        if (cancelled) return;
        setTranscriptPrompts(
          ums.map((e) => ({ uuid: e.id, time: e.timestamp, text: e.text })),
        );
      } catch {
        // Silent — annotations still drive the gutter on terminal surfaces;
        // peek surfaces just stay empty until the next refresh.
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    void fetchPrompts();
    const unsub = process.on('status', () => { void fetchPrompts(); });
    return () => { cancelled = true; unsub(); };
  }, [process?.id]);

  const promptEntries = useMemo<PromptEntry[]>(
    () =>
      transcriptPrompts.map((tp) => ({
        absRow: null,
        text: tp.text,
        time: tp.time,
        source: 'transcript' as const,
      })),
    [transcriptPrompts],
  );

  return { transcriptPrompts, promptEntries, isLoading };
}
