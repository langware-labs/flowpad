import { cn } from '@src/lib/utils';

/**
 * An onboarding-style attention marker: a pulsing "beacon" dot (the classic
 * hotspot pattern) sitting at the top-left corner of the highlighted element,
 * pointing at it. Decorative only. See docs/wikitip.md.
 */
export function HighlightBeacon({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('pointer-events-none absolute -left-1.5 -top-1.5 z-10 flex h-3.5 w-3.5', className)}
    >
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/70" />
      <span className="relative inline-flex h-3.5 w-3.5 rounded-full bg-primary ring-2 ring-background" />
    </span>
  );
}
