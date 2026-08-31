import { AgenticProcess } from '@sdk';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PromptEntry } from './PromptIndexPanel';
import { promptDisplayText } from './promptDisplay';

export interface TranscriptPrompt {
  uuid: string;
  time: string;
  text: string;
}

export interface UsePromptsForProcessResult {
  transcriptPrompts: TranscriptPrompt[];
  promptEntries: PromptEntry[];
  isLoading: boolean;
  refresh: () => void;
}

/**
 * Loads the canonical user-prompt list for an AgenticProcess via
 * `transcript/prompts`. Fetches once on mount, once when the bound
 * process identity changes, and on demand via `refresh()` (e.g. ~1s
 * after the user presses Enter in the terminal).
 *
 * `text` is run through `promptDisplayText` — a PRESENTATION step, not a
 * storage one. The transcript keeps both rows Claude Code writes for a slash
 * command; the index renders the typed `/rca <args>` row and skips the
 * `is_meta` row holding the expanded SKILL.md. See `promptDisplay.ts`.
 *
 * Returns both shapes:
 *   - `transcriptPrompts`: `{ uuid, time, text }` triples, used by callers
 *     that join with terminal annotations to compute `absRow`.
 *   - `promptEntries`: read-only `PromptEntry[]` with `absRow: null`, suitable
 *     for surfaces with no live terminal (e.g. peek from HistoryModal).
 */
export function usePromptsForProcess(process: AgenticProcess | null): UsePromptsForProcessResult {
  const [transcriptPrompts, setTranscriptPrompts] = useState<TranscriptPrompt[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  // Generation token: in-flight fetches whose generation is stale (process
  // changed, or a newer refresh started) discard their result.
  const fetchGenRef = useRef(0);

  const refresh = useCallback(() => {
    if (!process) {
      fetchGenRef.current += 1;
      setTranscriptPrompts([]);
      setIsLoading(false);
      return;
    }
    const myGen = ++fetchGenRef.current;
    setIsLoading(true);
    void (async () => {
      try {
        const ums = await process.getPrompts();
        if (fetchGenRef.current !== myGen) return;
        const shown: TranscriptPrompt[] = [];
        for (const e of ums) {
          const text = promptDisplayText(e.text, e.is_meta);
          if (text === null) continue;
          shown.push({ uuid: e.id, time: e.timestamp, text });
        }
        setTranscriptPrompts(shown);
      } catch {
        // Silent — annotations still drive the gutter on terminal surfaces;
        // peek surfaces just stay empty until the next refresh.
      } finally {
        if (fetchGenRef.current === myGen) setIsLoading(false);
      }
    })();
  }, [process?.id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

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

  return { transcriptPrompts, promptEntries, isLoading, refresh };
}
