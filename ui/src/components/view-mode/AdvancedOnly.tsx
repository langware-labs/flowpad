import type { ReactNode } from 'react';
import { useIsAdvanced } from '@src/contexts/view-mode-context';
import { cn } from '@src/lib/utils';

/**
 * Wraps a surface that only appears in Advanced view.
 *
 * `reserve` (default true): the element stays mounted in Standard view
 * (`visibility:hidden`) so its layout footprint is preserved and toggling View
 * causes no layout shift. Use in fixed grid/row layouts. `className` carries the
 * layout classes.
 *
 * `reserve={false}`: the element is unmounted in Standard view. Use in flow
 * layouts where collapsing the gap is desired and a shift is acceptable.
 *
 * Skin-layer rule: this only changes visibility/mounting — never data, hooks, or
 * behavior. See docs/viewmodes.md.
 */
export function AdvancedOnly({
  className,
  children,
  reserve = true,
}: {
  className?: string;
  children: ReactNode;
  reserve?: boolean;
}) {
  const isAdvanced = useIsAdvanced();
  if (!isAdvanced && !reserve) return null;
  return (
    <div className={cn(className, !isAdvanced && 'invisible')} aria-hidden={!isAdvanced}>
      {children}
    </div>
  );
}
