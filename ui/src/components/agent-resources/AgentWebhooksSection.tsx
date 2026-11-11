import { useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Agent, type AgentChannels, type TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { FlowIcon } from '@sdk/react/FlowIcon';
import { NavigatorSection } from '@src/components/navigator-panel/NavigatorSection';
import { Empty, ResourceRow } from './parts';

export const providerIcon = (provider: string) =>
  function ProviderIcon({ className }: { className?: string }) {
    return <FlowIcon icon={`brands.${provider}`} className={className} />;
  };

/** `agent.channels()` for one agent, read once per agent id; `null` while loading. */
export function useAgentChannels(agent: Agent | null | undefined): AgentChannels | null {
  const [wired, setWired] = useState<AgentChannels | null>(null);
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const agentId = agent?.id;
  useEffect(() => {
    if (!agentRef.current) return;
    let live = true;
    agentRef.current
      .channels()
      .then((data) => live && setWired(data))
      .catch(() => live && setWired({ deployments: [], webhooks: [], connections: [] }));
    return () => {
      live = false;
    };
  }, [agentId]);
  return wired;
}

/**
 * What the agent is wired to on the hub: the links that bring messages to it (a Slack DM, a WhatsApp number) and
 * the connections its machine may use. Names and states only — a link's code or a token never reaches the page.
 */
export function AgentWebhooksSection({ agentTypeId }: { agentTypeId: TypeId }) {
  const { t } = useLingui();
  const { data: agent } = useEntity<Agent>(agentTypeId);
  const wired = useAgentChannels(agent);
  const webhooks = wired?.webhooks ?? [];
  const connections = [...new Set((wired?.connections ?? []).map((c) => c.provider))];
  return (
    <NavigatorSection
      scope="agent-resources"
      id="webhooks"
      label={t`Webhooks & connections`}
      isLoading={wired === null}
      itemCount={webhooks.length + connections.length}
      emptyState={
        <Empty>
          <Trans>No channel links to this agent yet</Trans>
        </Empty>
      }
    >
      {webhooks.map((hook) => (
        <ResourceRow
          key={hook.id}
          icon={providerIcon(hook.provider)}
          label={hook.sender ? `${hook.provider} · ${hook.sender}` : hook.provider}
          detail={
            hook.status === 'active' ? t`Linked` : hook.status === 'pending' ? t`Waiting for the link` : t`Lapsed`
          }
          muted={hook.status === 'lapsed'}
          selected={false}
          onOpen={() => undefined}
          testId={`agent-resource-webhook-${hook.id}`}
        />
      ))}
      {connections.map((provider) => (
        <ResourceRow
          key={`connection-${provider}`}
          icon={providerIcon(provider)}
          label={t`${provider} connection`}
          detail={t`The agent's machine may use it`}
          selected={false}
          onOpen={() => undefined}
          testId={`agent-resource-connection-${provider}`}
        />
      ))}
    </NavigatorSection>
  );
}
