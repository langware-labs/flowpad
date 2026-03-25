import { useMemo, useRef } from 'react';

export function useInputHistory() {
  const history = useRef<string[]>([]);
  const historyIndex = useRef<number>(-1);
  const tempInput = useRef<string>('');

  const addToHistory = (input: string) => {
    const trimmed = input.trim();
    if (!trimmed || history.current[history.current.length - 1] === trimmed) return;
    history.current.push(trimmed);
    historyIndex.current = -1;
  };

  const navigateUp = (currentInput: string) => {
    if (history.current.length === 0) return currentInput;

    if (historyIndex.current === -1) {
      tempInput.current = currentInput;
      historyIndex.current = history.current.length - 1;
    } else if (historyIndex.current > 0) {
      historyIndex.current--;
    }

    return history.current[historyIndex.current];
  };

  const navigateDown = (currentInput: string) => {
    // Not in navigation mode - return current input unchanged
    if (historyIndex.current === -1) return currentInput;

    historyIndex.current++;

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
  };

  return useMemo(() => ({ addToHistory, navigateUp, navigateDown, clear }), []);
}
