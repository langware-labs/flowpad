import { Prompt } from '@sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * Whitespace-collapsed comparison key for pin-state checks. MUST match the
 * backend's ``normalize_prompt_text`` (prompt_pin_action.py) — both sides
 * compare history-item text to library prompts with the same key.
 */
export function normalizePromptText(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(' ');
}

/**
 * The project's library prompts, keyed by normalized text — powers the
 * per-history-item pin state in PromptIndexPanel. `refresh()` re-queries
 * after a pin/unpin mutation.
 */
export function useLibraryPromptsForProject(projectId: string | null | undefined): {
  byNormalizedText: ReadonlyMap<string, Prompt>;
  refresh: () => void;
  isLoading: boolean;
} {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (projectId === undefined) return;
    let cancelled = false;
    setIsLoading(true);
    void Prompt.listForProject(projectId ?? null)
      .then((result) => {
        if (!cancelled) setPrompts(result);
      })
      .catch(() => {
        if (!cancelled) setPrompts([]);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, generation]);

  const refresh = useCallback(() => setGeneration((g) => g + 1), []);

  const byNormalizedText = useMemo(() => {
    const map = new Map<string, Prompt>();
    for (const p of prompts) {
      const key = normalizePromptText(p.text ?? '');
      if (key && !map.has(key)) map.set(key, p);
    }
    return map;
  }, [prompts]);

  return { byNormalizedText, refresh, isLoading };
}

export default useLibraryPromptsForProject;
