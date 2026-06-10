import type { ReactNode } from 'react';
import { useIsAdvanced } from '@src/contexts/view-mode-context';
import { cn } from '@src/lib/utils';

/**
 * Wraps a surface that only appears in Advanced view. The element stays mounted
 * in Standard view (visibility:hidden) so its layout footprint is preserved and
 * toggling View causes no layout shift. `className` carries the layout classes.
 */
export function AdvancedOnly({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const isAdvanced = useIsAdvanced();
  return (
    <div className={cn(className, !isAdvanced && 'invisible')} aria-hidden={!isAdvanced}>
      {children}
    </div>
  );
}
