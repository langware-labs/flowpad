import type { AgenticProcess } from '@sdk';
import { createContext, useContext, useRef, type ReactNode } from 'react';
import type { LinkSurface } from './link-actions';
import type { LinkHandlers, LinkSource } from './link-events';
import { useLinks } from './LinkMenu';

const LinkHandlersContext = createContext<LinkHandlers | null>(null);

/** The links of the chat this text sits in, or null outside one (the text then renders plain). */
export function useLinkHandlers(): LinkHandlers | null {
  return useContext(LinkHandlersContext);
}

/**
 * One chat panel's links: one `useLinks` and one menu for every turn, thought and plan
 * inside it, resolved against `process` — as a terminal has one for all its lines.
 */
export function LinkScope({
  process,
  surface = 'tab',
  children,
}: {
  process: AgenticProcess | null;
  surface?: LinkSurface;
  children: ReactNode;
}) {
  const source = useRef<LinkSource | null>(process);
  source.current = process;
  const { handlers, menu } = useLinks(source, process, { surface });
  return (
    <LinkHandlersContext.Provider value={process ? handlers : null}>
      {children}
      {menu}
    </LinkHandlersContext.Provider>
  );
}
