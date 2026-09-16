import { Agent } from '@sdk';
import { useLingui } from '@lingui/react/macro';

import { AgentAvatar } from '@src/components/agents/AgentAvatar';
import { AgentIntroCard } from '@src/components/agents/AgentIntroCard';

/**
 * The identity row that signs an assistant turn AS an agent: avatar + name,
 * clickable for the intro card (who this is, what it is for, open it) — the
 * same handle everywhere an agent is named as an actor.
 */
export function AgentSignature({ agent }: { agent: Agent }) {
  const { t } = useLingui();
  const name = agent.displayName;
  return (
    <AgentIntroCard agent={agent}>
      <button
        type="button"
        className="flex items-center gap-2 rounded-full pe-2 hover:bg-muted/60"
        data-testid="execution-message-agent"
        title={t`About ${name}`}
      >
        <AgentAvatar
          agent={agent}
          className="h-5 w-5 text-[10px]"
          glyphClassName="h-3 w-3 text-xs"
          data-testid="execution-message-agent-avatar"
        />
        <span className="text-[13px] font-semibold text-foreground" data-testid="execution-message-name">
          {name}
        </span>
      </button>
    </AgentIntroCard>
  );
}
