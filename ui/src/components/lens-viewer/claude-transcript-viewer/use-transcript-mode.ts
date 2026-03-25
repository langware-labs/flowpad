import { useState } from 'react';

const STORAGE_KEY = 'transcript-viewer-mode';

export function useTranscriptMode() {
  const [mode, setModeState] = useState<'chat' | 'transcript'>(() => {
    try {
      return (localStorage.getItem(STORAGE_KEY) as 'chat' | 'transcript') ?? 'chat';
    } catch {
      return 'chat';
    }
  });

  const setMode = (m: 'chat' | 'transcript') => {
    setModeState(m);
    try {
      localStorage.setItem(STORAGE_KEY, m);
    } catch {
      // ignore
    }
  };

  return [mode, setMode] as const;
}
