import type { ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { Agent } from '@sdk';
import { ExternalLink } from 'lucide-react';

import { Button } from '@src/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { AgentAvatar } from './AgentAvatar';

interface AgentIntroCardProps {
  agent: Agent;
  /** The element that opens the card — an avatar, a name, an identity row. */
  children: ReactNode;
}

/**
 * Who is this? — the agent's intro card, opened from anywhere the agent is
 * named as an actor (a chat turn, the pinned asset row). Avatar, title, slug,
 * the authored one-line description, the runtime it runs on, and one action:
 * open the agent. Read-only; editing is the profile editor's job.
 */
export function AgentIntroCard({ agent, children }: AgentIntroCardProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const title = agent.displayName;
  const slug = agent.name && agent.name !== title ? agent.name : null;
  const runtime = [agent.worker_type, agent.model, agent.permission_mode].filter(Boolean) as string[];

  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0" data-testid="agent-intro-card">
        <div className="flex items-start gap-3 p-3">
          <AgentAvatar agent={agent} className="h-12 w-12 text-lg" glyphClassName="h-6 w-6 text-2xl" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-foreground" data-testid="agent-intro-card-title">
              {title}
            </div>
            {slug && <div className="truncate font-mono text-[11px] text-muted-foreground">{slug}</div>}
            <span className="mt-1 inline-block rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              <Trans>agent</Trans>
            </span>
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
              <span key={chip} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {chip}
              </span>
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
      </PopoverContent>
    </Popover>
  );
}
