import { createContext, useCallback, useContext, useRef, type ReactNode } from 'react';
import { cn } from '@src/lib/utils';

/**
 * A chat's scroll box, latest-first. `flex-col-reverse` anchors the scroll at the BOTTOM, so the
 * browser itself opens it on the latest message, follows new or late-growing content (arrivals,
 * images, chips, the composer) while you are at the bottom, keeps your place while you read back,
 * and holds the bottom through a resize — no follow logic to keep in step with every way content
 * changes size. `mb-auto` keeps short content at the top.
 *
 * `useScrollToLatest()` (for anything rendered inside, or in `after` — a composer pinned below the
 * box) brings the box to its latest, e.g. after your own send.
 */
const ScrollToLatestContext = createContext<(() => void) | null>(null);

export function LatestScroll({
  className,
  children,
  after,
}: {
  /** The box's own classes (size, padding, background); the scroll direction is fixed here. */
  className?: string;
  children: ReactNode;
  /** Rendered after the box but inside its context — a composer pinned below the scroll. */
  after?: ReactNode;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  // In a column-reverse box, scrollTop 0 IS the bottom. Assigned, not `scrollTo()`: jsdom lacks the
  // method on some versions (see use-auto-scroll).
  const scrollToLatest = useCallback(() => {
    if (boxRef.current) boxRef.current.scrollTop = 0;
  }, []);
  return (
    <ScrollToLatestContext.Provider value={scrollToLatest}>
      <div ref={boxRef} className={cn('flex min-h-0 flex-1 flex-col-reverse overflow-y-auto', className)}>
        <div className="mb-auto">{children}</div>
      </div>
      {after}
    </ScrollToLatestContext.Provider>
  );
}

/** Bring the enclosing {@link LatestScroll} to its latest; null outside one. */
export function useScrollToLatest(): (() => void) | null {
  return useContext(ScrollToLatestContext);
}
