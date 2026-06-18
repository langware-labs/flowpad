import type { ReactNode } from 'react';
import { useIsDev } from '@src/contexts/view-mode-context';
import { cn } from '@src/lib/utils';

/**
 * Wraps a surface that only appears in Dev view.
 *
 * `reserve` (default true): the element stays mounted in non-Dev views
 * (`visibility:hidden`) so its layout footprint is preserved and toggling View
 * causes no layout shift. Use in fixed grid/row layouts. `className` carries the
 * layout classes.
 *
 * `reserve={false}`: the element is unmounted in non-Dev views. Use in flow
 * layouts where collapsing the gap is desired and a shift is acceptable.
 *
 * Skin-layer rule: this only changes visibility/mounting — never data, hooks, or
 * behavior. See docs/viewmodes.md.
 */
export function DevOnly({
  className,
  children,
  reserve = true,
}: {
  className?: string;
  children: ReactNode;
  reserve?: boolean;
}) {
  const isDev = useIsDev();
  if (!isDev && !reserve) return null;
  return (
    <div className={cn(className, !isDev && 'invisible')} aria-hidden={!isDev}>
      {children}
    </div>
  );
}
