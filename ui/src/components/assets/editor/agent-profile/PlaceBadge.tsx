import type { AgentPlace } from '@sdk';

import { cn } from '@src/lib/utils';
import { usePlaceBadge, type BadgePlace } from './use-place-display';

/** Where an automation runs, as an icon and a short name — the same chip on every schedule surface. */
export function PlaceBadge({
  place,
  className,
  testId,
  places,
}: {
  place: BadgePlace;
  className?: string;
  testId?: string;
  /** The agent's places — names a cloud machine the place itself does not. */
  places?: AgentPlace[];
}) {
  const { label, Icon } = usePlaceBadge(places)(place);
  return (
    <span
      className={cn('inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground', className)}
      title={label}
      data-place={place.kind}
      data-testid={testId}
    >
      <Icon className="size-3.5" aria-hidden />
      {label}
    </span>
  );
}
