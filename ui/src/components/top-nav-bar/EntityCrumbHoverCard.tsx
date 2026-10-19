import type { ReactNode } from 'react';
import type { TypeId } from '@sdk';
import { EntityCard } from '@src/components/entity-card/EntityCard';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@src/components/ui/hover-card';

/**
 * "Which one is this" — the card behind a crumb that names ONE entity (a
 * conversation, a session, a task, a data source…), opened on hover like the
 * project crumb's.
 */
export function EntityCrumbHoverCard({
  typeId,
  label,
  children,
}: {
  typeId: TypeId;
  label: string;
  children: ReactNode;
}) {
  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent side="bottom" align="start" className="w-auto p-0" data-testid="top-nav-entity-details">
        <EntityCard type={typeId.type} id={typeId.id} fallbackName={label} />
      </HoverCardContent>
    </HoverCard>
  );
}
