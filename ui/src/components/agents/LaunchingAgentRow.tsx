import { useLingui } from '@lingui/react/macro';
import type { Agent } from '@sdk';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { cn } from '@src/lib/utils';
import { AgentAvatar } from './AgentAvatar';
import { AgentTypeChip } from './AgentIntroCard';

/**
 * The run's principal: the Agent a process was launched through. Avatar, then
 * the name; the row opens the agent's page.
 */
export function LaunchingAgentRow({
  agent,
  testId,
  className,
}: {
  agent: Agent;
  testId: string;
  className?: string;
}) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const name = agent.displayName;

  return (
    <button
      type="button"
      onClick={() => navigation.openDock(agent.dockPointer)}
      className={cn(
        'flex items-center gap-2 rounded border border-border bg-muted/30 px-2.5 py-1.5 text-start hover:bg-muted',
        className,
      )}
      data-testid={testId}
      title={t`Open ${name}`}
    >
      <AgentAvatar agent={agent} className="h-6 w-6 text-[11px]" data-testid={`${testId}-avatar`} />
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" data-testid={`${testId}-name`}>
        {name}
      </span>
      <AgentTypeChip className="flex-shrink-0" />
    </button>
  );
}
