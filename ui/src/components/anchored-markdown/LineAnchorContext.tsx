import { createContext, useContext, useEffect, useState } from 'react';

import type { LineAnchorProvider } from './types';

const Ctx = createContext<LineAnchorProvider | null>(null);

export const LineAnchorProviderCtx = Ctx;

/**
 * Read the active LineAnchorProvider from context. Components that render
 * anchored markers should call this and re-render whenever the provider's
 * subscribe callback fires (covered by useAnchorVersion below).
 */
export function useLineAnchorProvider(): LineAnchorProvider | null {
  return useContext(Ctx);
}

/**
 * Re-render hook — bumps a counter every time the provider notifies a layout
 * change. Tracks call this and read the latest rects via getRect inline.
 */
export function useAnchorVersion(provider: LineAnchorProvider | null): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!provider) return;
    return provider.subscribe(() => setVersion((v) => v + 1));
  }, [provider]);
  return version;
}
