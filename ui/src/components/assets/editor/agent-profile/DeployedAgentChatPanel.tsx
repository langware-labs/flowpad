import { Agent, AgenticProcess, Deployment, ProcessKind } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useCallback } from 'react';

import { AgentAvatar } from '@src/components/agents/AgentAvatar';
import { EntityExecutionPanel } from '@src/components/entity-execution-panel';
import { badgeVariants } from '@src/components/ui/badge';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

interface DeployedAgentChatPanelProps {
  agent: Agent;
  deployment: Deployment;
}

/** The ordinary chat panel, bound to one exact production Agent placement. */
export function DeployedAgentChatPanel({ agent, deployment }: DeployedAgentChatPanelProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();

  const createProcess = useCallback(async () => {
    const receipt = await agent.useDeployment(deployment.id);
    const process = await AgenticProcess.getById<AgenticProcess>(receipt.process_id);
    if (!process) throw new Error('The deployed Agent process could not be opened');
    return process;
  }, [agent, deployment.id]);

  return (
    <div className="flex h-[32rem] min-h-0 flex-col border-t bg-background" data-testid="deployed-agent-chat">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <AgentAvatar agent={agent} className="h-8 w-8 text-xs" data-testid="deployed-agent-chat-avatar" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold" data-testid="deployed-agent-chat-title">
            {agent.displayName}
          </div>
          <button
            type="button"
            className={badgeVariants({
              variant: 'secondary',
              className: 'mt-0.5 cursor-pointer px-1.5 py-0 text-[10px]',
            })}
            onClick={() => navigation.openDock(agent.dockPointer)}
            data-testid="deployed-agent-chat-agent-link"
          >
            <Trans>Deployed agent</Trans>
          </button>
        </div>
      </div>
      <EntityExecutionPanel
        target={agent.typeId.toString()}
        processType={ProcessKind.Chat}
        deploymentId={deployment.id}
        createProcess={createProcess}
        className="min-h-0 flex-1"
        dense
        newSessionLabel={t`New chat`}
        historyLabel={t`Chat history`}
        pastSessionsLabel={t`Past chats`}
        noPastSessionsLabel={t`No past chats`}
        emptyStateText={t`Send a message to this deployed agent.`}
        placeholder={t`Message this deployed agent…`}
        showAssetManager={false}
        showProjectSetting={false}
        allowAttachments={false}
        allowImagePaste={false}
      />
    </div>
  );
}
