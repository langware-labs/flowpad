import type { Agent, PublicDeploymentsState } from '@sdk';
import { isHubOnly } from '@sdk/utils/hub-runtime';
import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronRight, Loader2, Mail, Server, Ticket } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@src/components/ui/button';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

import { providerIcon, useAgentChannels } from '@src/components/agent-resources/AgentWebhooksSection';
import { isPublicPlace, useAgentPlaces, type AgentPlace } from './use-agent-places';
import { usePlaceDisplay } from './use-place-display';
import { AgentPeopleList } from './AgentPeopleList';

interface AgentPlacesColumnProps {
  agent: Agent;
  /** Open the agent's invite deployment (its one row in this list). */
  onOpenInvite?: () => void;
}

/**
 * Where the agent answers — every deployment it is the main agent of, this computer first — each a link to
 * that deployment's page in its PROJECT's Deployments, where it is run. "Deploy" opens the project's
 * Deployments with this agent preset as the main agent of a new deployment. A deployment belongs to its
 * project; the agent page only shows where it is main.
 */
export function AgentPlacesColumn({ agent, onOpenInvite }: AgentPlacesColumnProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const display = usePlaceDisplay();
  const { places } = useAgentPlaces(agent);
  // The hub answers what is wired to the agent (links, connections) in one read.
  const wired = useAgentChannels(agent);
  const hub = isHubOnly();

  const visible = (places ?? []).filter((p) => !isPublicPlace(p.deployment));
  // The invite deployment is ONE row: its machines live inside it, never as rows of their own.
  const [invites, setInvites] = useState<PublicDeploymentsState | null>(null);
  useEffect(() => {
    let live = true;
    agent
      .publicDeployments()
      .then((s) => live && setInvites(s))
      .catch(() => live && setInvites(null));
    return () => {
      live = false;
    };
  }, [agent]);
  const invite = invites?.settings?.allow_visitor_deployment ? invites : null;
  const inviteRow = invite && (
    <li className="flex items-center">
      <button
        type="button"
        onClick={onOpenInvite}
        className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-start hover:bg-muted/60"
        data-testid="agent-invite-row"
      >
        <Ticket className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm">{t`Invite · ${agent.displayName || agent.name}`}</span>
          <span className="truncate text-xs text-muted-foreground">
            {[
              invite.settings?.mode === 'link' ? t`Anyone with the link` : t`Invite code only`,
              invite.settings?.max_deployments
                ? t`${invite.deployments.length} of ${invite.settings.max_deployments} machines in use`
                : t`${invite.deployments.length} machines in use`,
              invite.settings?.cap_usd != null ? t`$${invite.settings.cap_usd} per user` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{t`On`}</span>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground rtl:-scale-x-100" />
      </button>
    </li>
  );
  const hubRows = (wired?.deployments ?? []).filter((d) => !isPublicPlace(d));
  const openPage = (place: AgentPlace) => {
    const pointer = place.deployment.projectPagePointer;
    if (pointer) navigation.openDock(pointer);
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby="agent-deployments" data-testid="agent-places">
      <h2 id="agent-deployments" className="text-sm font-semibold">
        <Trans>Deployments</Trans>
      </h2>
      {places === null ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : visible.length === 0 && hub && hubRows.length > 0 ? (
        <ul className="flex flex-col divide-y rounded-md border" data-testid="agent-hub-deployments">
          {inviteRow}
          {hubRows.map((d) => (
            <li key={d.typeid} className="flex items-center gap-2 px-3 py-2 text-sm">
              <Server className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{d.node_typeid ? t`Cloud machine` : t`No machine yet`}</span>
            </li>
          ))}
        </ul>
      ) : visible.length === 0 && inviteRow ? (
        <ul className="flex flex-col divide-y rounded-md border" data-testid="agent-places-list">
          {inviteRow}
        </ul>
      ) : visible.length === 0 && wired?.deployments.some((d) => d.agent_mode === 'private') ? null : visible.length ===
        0 ? (
        <span className="text-xs text-muted-foreground" data-testid="agent-places-empty">
          <Trans>Not deployed yet — it runs nowhere until you launch it.</Trans>
        </span>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border" data-testid="agent-places-list">
          {inviteRow}
          {visible.map((place) => {
            const { label, Icon } = display(place);
            return (
              <li key={place.deployment.id} className="flex items-center">
                <button
                  type="button"
                  onClick={() => openPage(place)}
                  className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-start hover:bg-muted/60"
                  data-testid={`agent-place-row-${place.deployment.id}`}
                >
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
                  <span
                    className="shrink-0 text-xs text-muted-foreground"
                    data-testid={`agent-place-state-${place.deployment.id}`}
                  >
                    {stateOf(place)}
                  </span>
                </button>
                {/* What this place answers is read in the agent's stream inbox: one StreamInbox per agent, so every
                    row opens the same place — a sibling of the row button, never nested in it. */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="me-1 shrink-0 text-muted-foreground"
                  onClick={() => navigation.openDock(DockPointer.forAgentStreamInbox(agent.id))}
                  aria-label={t`Open stream inbox`}
                  title={t`Open stream inbox`}
                  data-testid={`agent-place-stream-inbox-${place.deployment.id}`}
                >
                  <Mail className="h-4 w-4" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {wired?.deployments.some((d) => d.agent_mode === 'private') && <AgentPeopleList people={wired.people ?? []} />}
      {wired && (wired.webhooks.length > 0 || wired.connections.length > 0) && (
        <div className="flex flex-col gap-1.5" data-testid="agent-wiring">
          <h3 className="text-xs font-semibold text-muted-foreground">
            <Trans>Webhooks & connections</Trans>
          </h3>
          <ul className="flex flex-col divide-y rounded-md border">
            {wired.webhooks.map((hook) => {
              const Icon = providerIcon(hook.provider);
              return (
                <li
                  key={hook.id}
                  className="flex items-center gap-2 px-3 py-2 text-sm"
                  data-testid={`agent-webhook-${hook.id}`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    {hook.sender ? `${hook.provider} · ${hook.sender}` : hook.provider}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {hook.status === 'active'
                      ? t`Linked`
                      : hook.status === 'pending'
                        ? t`Waiting for the link`
                        : t`Lapsed`}
                  </span>
                </li>
              );
            })}
            {[...new Set(wired.connections.map((c) => c.provider))].map((provider) => {
              const Icon = providerIcon(provider);
              return (
                <li
                  key={`c-${provider}`}
                  className="flex items-center gap-2 px-3 py-2 text-sm"
                  data-testid={`agent-connection-${provider}`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{t`${provider} connection`}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{t`Its machine may use it`}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );

  function stateOf(place: AgentPlace): string {
    if (place.deployment.status?.provider_state === 'paused') return t`Paused`;
    // Planned and never placed (a refused or not-yet-run deploy): no machine answers, so never "Running".
    if (!place.is_local && place.deployment.status?.provider_state === 'planned') return t`Not started`;
    return place.is_local ? t`On` : t`Running`;
  }
}
