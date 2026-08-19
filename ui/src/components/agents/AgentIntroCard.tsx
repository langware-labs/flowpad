import type { ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Agent } from '@sdk';
import { ExternalLink } from 'lucide-react';

import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { workerLabel } from '@src/components/lens-viewer/shared/transcript-features/transcript-utils';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@src/components/ui/hover-card';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { cn } from '@src/lib/utils';
import { AgentAvatar } from './AgentAvatar';

interface AgentIntroCardProps {
  agent: Agent;
  /** The element that opens the card — an avatar, a name, an identity row. */
  children: ReactNode;
  /**
   * How the card opens. `click` (default) is the identity-row behaviour: the
   * trigger's whole job is to explain who this is. `hover` is for a trigger
   * that already HAS a primary action — an agent tile, whose click must start
   * the session — where a click-trigger would swallow it.
   */
  trigger?: 'click' | 'hover';
}

/**
 * Who is this? — the agent's intro card, opened from anywhere the agent is
 * named as an actor (a chat turn, the pinned asset row). Avatar, title, slug,
 * the authored one-line description, the runtime it runs on, and one action:
 * open the agent. Read-only; editing is the profile editor's job.
 */
export function AgentIntroCard({ agent, children, trigger = 'click' }: AgentIntroCardProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const title = agent.displayName;
  const slug = agent.name && agent.name !== title ? agent.name : null;
  const runtime = [
    agent.worker_type ? workerLabel(agent.worker_type) : null,
    agent.model,
    agent.permission_mode,
  ].filter((chip): chip is string => !!chip);

  // ONE card body, two ways of opening it — never a second description popover
  // that could drift from this one. Spelled out as two returns rather than a
  // swapped component tuple so each primitive's own props stay type-checked.
  const body = (
    <>
      <div className="flex items-start gap-3 p-3">
        <AgentAvatar agent={agent} className="h-12 w-12 text-lg" glyphClassName="h-6 w-6 text-2xl" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground" data-testid="agent-intro-card-title">
            {title}
          </div>
          {slug && <div className="truncate font-mono text-[11px] text-muted-foreground">{slug}</div>}
          <AgentTypeChip className="mt-1" />
        </div>
      </div>
      {agent.description ? (
        <p className="px-3 pb-3 text-xs leading-relaxed text-foreground/90" data-testid="agent-intro-card-description">
          {agent.description}
        </p>
      ) : (
        <p className="px-3 pb-3 text-xs italic text-muted-foreground">
          <Trans>No description yet.</Trans>
        </p>
      )}
      {runtime.length > 0 && (
        <div className="flex flex-wrap gap-1 px-3 pb-3">
          {runtime.map((chip) => (
            <Badge key={chip} variant="secondary" className="font-mono text-[10px] font-normal">
              {chip}
            </Badge>
          ))}
        </div>
      )}
      <div className="border-t border-border p-2">
        <Button
          size="sm"
          variant="ghost"
          className="w-full justify-start"
          onClick={() => navigation.openDock(agent.dockPointer)}
          data-testid="agent-intro-card-open"
          title={t`Open ${title}`}
        >
          <ExternalLink className="me-1.5 h-3.5 w-3.5" />
          <Trans>Open agent</Trans>
        </Button>
      </div>
    </>
  );

  if (trigger === 'hover') {
    return (
      <HoverCard openDelay={200} closeDelay={100}>
        <HoverCardTrigger asChild>{children}</HoverCardTrigger>
        <HoverCardContent align="start" className="w-72 p-0" data-testid="agent-intro-card">
          {body}
        </HoverCardContent>
      </HoverCard>
    );
  }
  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0" data-testid="agent-intro-card">
        {body}
      </PopoverContent>
    </Popover>
  );
}

/** The small uppercase type chip shown beside an agent's name. The word comes
 *  from the type registry (`TypeInfo.display_name`), the same choke point the
 *  section heading uses — a literal here would fork the type's own name. */
export function AgentTypeChip({ className }: { className?: string }) {
  return (
    <Badge variant="outline" className={cn('text-[10px] font-normal uppercase tracking-wider text-muted-foreground', className)}>
      {labelForType(Agent.type)}
    </Badge>
  );
}
