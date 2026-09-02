import type { ComponentType } from 'react';
import { cn } from '@src/lib/utils';

export type IconComp = ComponentType<{ className?: string }>;

interface IconWithBadgeProps {
  /** The main glyph (fills the box). */
  Base: IconComp;
  /** The small corner glyph overlaid on the bottom-right; null → base-only. */
  Badge: IconComp | null;
  /** Sizing of the whole composite (e.g. `h-3 w-3`). */
  className?: string;
  /** Extra classes for the badge (e.g. a vendor color). */
  badgeClassName?: string;
  /** Extra classes for the base only (e.g. instance-state color). */
  baseClassName?: string;
  'aria-label'?: string;
  'data-testid'?: string;
}

/**
 * Generic "base icon + bottom-right corner badge" composer: a `relative
 * inline-flex` box with the base glyph filling it and the badge pinned to the
 * bottom-right on a rounded background chip. A null `Badge` degrades to a plain
 * base icon, so call sites never need their own base-only branch.
 *
 * The `*RestoreIcon` components and `ClaudeResumeIcon` hand-roll this same
 * markup and can migrate onto this composer later.
 *
 * Stable module-level component — pass already-resolved icon COMPONENTS, never
 * inline closures, so consumers keep their memoization.
 */
export function IconWithBadge({
  Base,
  Badge,
  className,
  badgeClassName,
  baseClassName,
  ...rest
}: IconWithBadgeProps) {
  if (!Badge) return <Base className={cn(className, baseClassName)} />;
  return (
    <span className={cn('relative inline-flex', className)} {...rest}>
      <Base className={cn('h-full w-full', baseClassName)} />
      <Badge
        className={cn(
          'absolute -bottom-0.5 -right-0.5 h-[55%] w-[55%] rounded-full bg-background p-px',
          badgeClassName,
        )}
      />
    </span>
  );
}
