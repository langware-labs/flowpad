import { cn } from '@src/lib/utils';

/**
 * The small count chip that rides an icon button — unread inbox, unopened
 * bookmarks. Absolutely positioned, so its host only has to be `relative`.
 *
 * Module scope, not declared inside a component: a component defined in a render
 * body is a NEW type every render, so React would remount the span rather than
 * reconcile it. Shared because the rail and the navigation bar both carry one
 * and a second copy would drift on size or color.
 *
 * The default placement is the rail's 20px glyph. `className` exists for a
 * tighter host — the bar's star is 14px, where the rail's inset would put the
 * chip in the middle of the icon.
 */
export function NavBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        'pointer-events-none absolute end-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-0.5 text-[9px] font-bold leading-none text-destructive-foreground',
        className,
      )}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
