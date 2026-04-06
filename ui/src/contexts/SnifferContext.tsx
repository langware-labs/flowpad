import { createContext, useContext, type ReactNode } from 'react';
import { useHooksSniffer } from '@src/hooks/use-hooks-sniffer';

type SnifferContextValue = ReturnType<typeof useHooksSniffer>;

const SnifferContext = createContext<SnifferContextValue | null>(null);

export function SnifferProvider({ children }: { children: ReactNode }) {
  const value = useHooksSniffer();
  return <SnifferContext.Provider value={value}>{children}</SnifferContext.Provider>;
}

export function useSnifferContext(): SnifferContextValue {
  const ctx = useContext(SnifferContext);
  if (!ctx) throw new Error('useSnifferContext must be used inside SnifferProvider');
  return ctx;
}
