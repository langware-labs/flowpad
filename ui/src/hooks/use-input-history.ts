import { useMemo, useReducer, useRef } from 'react';

export interface InputHistory {
  addToHistory: (input: string) => void;
  navigateUp: (currentInput: string) => string;
  navigateDown: (currentInput: string) => string;
  clear: () => void;
  /**
   * Replace the history contents wholesale (e.g. hydrate from a loaded
   * transcript's user messages). No-op when the entries are unchanged, so it
   * is safe to call from an effect on every derivation. Resets any in-flight
   * browsing when the entries actually change.
   */
  seed: (entries: string[]) => void;
  /** Jump browsing directly to an entry (e.g. a click on the history list). */
  select: (index: number) => string;
  /** Leave browsing mode; returns the stashed draft to restore. */
  exitBrowsing: () => string;
  /** Snapshot of the history entries, oldest first. */
  entries: readonly string[];
  /** Current browsing position in `entries`, or -1 when not browsing. */
  index: number;
  /** True while the user is arrow-key browsing (index !== -1). */
  browsing: boolean;
}

/** ArrowUp only browses history when the caret sits on the textarea's first line. */
export function caretOnFirstLine(ta: HTMLTextAreaElement): boolean {
  return !ta.value.substring(0, ta.selectionStart ?? 0).includes('\n');
}

/** ArrowDown only browses history when the caret sits on the textarea's last line. */
export function caretOnLastLine(ta: HTMLTextAreaElement): boolean {
  return !ta.value.substring(ta.selectionStart ?? 0).includes('\n');
}

function dedupConsecutive(entries: string[]): string[] {
  const out: string[] = [];
  for (const raw of entries) {
    const trimmed = raw.trim();
    if (!trimmed || out[out.length - 1] === trimmed) continue;
    out.push(trimmed);
  }
  return out;
}

export function useInputHistory(): InputHistory {
  const history = useRef<string[]>([]);
  const historyIndex = useRef<number>(-1);
  const tempInput = useRef<string>('');
  // Refs stay the single source of truth (stable callbacks for keydown
  // handlers); the version bump re-renders consumers that read the reactive
  // `entries` / `index` snapshot (the history list UI).
  const [version, bump] = useReducer((c: number) => c + 1, 0);

  const addToHistory = (input: string) => {
    const trimmed = input.trim();
    if (!trimmed || history.current[history.current.length - 1] === trimmed) return;
    history.current.push(trimmed);
    historyIndex.current = -1;
    bump();
  };

  const navigateUp = (currentInput: string) => {
    if (history.current.length === 0) return currentInput;

    if (historyIndex.current === -1) {
      tempInput.current = currentInput;
      historyIndex.current = history.current.length - 1;
    } else if (historyIndex.current > 0) {
      historyIndex.current--;
    }
    bump();
    return history.current[historyIndex.current];
  };

  const navigateDown = (currentInput: string) => {
    // Not in navigation mode - return current input unchanged
    if (historyIndex.current === -1) return currentInput;

    historyIndex.current++;
    bump();

    if (historyIndex.current >= history.current.length) {
      historyIndex.current = -1;
      const draft = tempInput.current;
      tempInput.current = '';
      return draft;
    }

    return history.current[historyIndex.current];
  };

  const clear = () => {
    historyIndex.current = -1;
    tempInput.current = '';
    bump();
  };

  const seed = (entries: string[]) => {
    const cleaned = dedupConsecutive(entries);
    const current = history.current;
    if (cleaned.length === current.length && cleaned.every((e, i) => e === current[i])) return;
    history.current = cleaned;
    historyIndex.current = -1;
    tempInput.current = '';
    bump();
  };

  const select = (index: number) => {
    if (index < 0 || index >= history.current.length) return '';
    if (historyIndex.current === -1) tempInput.current = '';
    historyIndex.current = index;
    bump();
    return history.current[index];
  };

  const exitBrowsing = () => {
    const wasBrowsing = historyIndex.current !== -1;
    historyIndex.current = -1;
    const draft = tempInput.current;
    tempInput.current = '';
    if (wasBrowsing) bump();
    return draft;
  };

  return useMemo(
    () => ({
      addToHistory,
      navigateUp,
      navigateDown,
      clear,
      seed,
      select,
      exitBrowsing,
      entries: [...history.current],
      index: historyIndex.current,
      browsing: historyIndex.current !== -1,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );
}
