import { useState, type ReactNode } from 'react';
import type { TypeId } from '@sdk';
import { EntityCard } from '@src/components/entity-card/EntityCard';
import { EntityTags } from '@src/components/tags/EntityTags';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@src/components/ui/hover-card';
import { useHoldOpenWhileTyping } from '@src/hooks/use-hold-open-while-typing';

/**
 * "Which one is this" — the card behind a crumb that names ONE entity (a
 * conversation, a session, a task, a data source…), opened on hover like the
 * project crumb's. Its tags are edited here, under the card.
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
  const [open, setOpen] = useState(false);
  const { holdsOpen, contentProps } = useHoldOpenWhileTyping();
  return (
    <HoverCard
      open={open}
      onOpenChange={(next) => (next || !holdsOpen()) && setOpen(next)}
      openDelay={200}
      closeDelay={100}
    >
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        {...contentProps}
        side="bottom"
        align="start"
        className="w-auto p-0"
        data-testid="top-nav-entity-details"
      >
        <EntityCard type={typeId.type} id={typeId.id} fallbackName={label} />
        <EntityTags typeId={typeId} className="max-w-[320px] border-t px-2.5 py-1.5" />
      </HoverCardContent>
    </HoverCard>
  );
}
