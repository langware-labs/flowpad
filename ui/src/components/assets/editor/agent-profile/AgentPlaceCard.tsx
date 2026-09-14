import { Agent, Deployment, type AgentPlace } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMemo, useRef, useState } from 'react';
import { Cloud, Laptop, Loader2, MessageSquare, MoreHorizontal } from 'lucide-react';

import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { Button } from '@src/components/ui/button';
import { Switch } from '@src/components/ui/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@src/components/ui/tabs';
import { showDeleteAssetModal } from '@src/components/assets/delete-asset-modal';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

import { AgentPlaceActivity } from './AgentPlaceActivity';
import { AgentPlaceConfig } from './AgentPlaceConfig';
import { AgentPlaceEmail } from './AgentPlaceEmail';
import { AgentScheduleSection } from './AgentScheduleSection';
import { DeployedAgentChatPanel } from './DeployedAgentChatPanel';

export const PLACE_TABS = ['activity', 'schedules', 'config', 'email'] as const;
export type PlaceTab = (typeof PLACE_TABS)[number];

/** Dock option holding one place card's selected tab. Per card, so two cards keep their own tab. */
export function placeTabOption(deploymentId: string): string {
  return `tab-${deploymentId}`;
}
/** Dock option naming the place whose chat is open. */
export const PLACE_CHAT_OPTION = 'chat';

interface AgentPlaceCardProps {
  agent: Agent;
  place: AgentPlace;
  places: AgentPlace[];
  autoLaunchPrompt?: string;
  pendingChanges?: number;
  onChanged: () => void | Promise<void>;
}

/**
 * One place this agent runs on: this computer, or a cloud machine.
 *
 * The selected tab and the open chat live in the URL (dock options) — a click
 * only navigates, per the URL-first rule.
 */
export function AgentPlaceCard({
  agent,
  place,
  places,
  autoLaunchPrompt,
  pendingChanges = 0,
  onChanged,
}: AgentPlaceCardProps) {
  const { t } = useLingui();
  const { navigation, currentDock } = useDockNavigation();
  // Keyed by identity, not by the row object: every places reload hands back fresh
  // objects, and a new Deployment here would refetch this card's runs each time.
  const row = useRef(place.deployment);
  row.current = place.deployment;
  const updated = typeof place.deployment.updated_date === 'string' ? place.deployment.updated_date : '';
  const deploymentKey = `${place.deployment.id}:${updated}`;
  const deployment = useMemo(() => {
    void deploymentKey; // the identity this Deployment was built for
    return new Deployment(row.current as never);
  }, [deploymentKey]);
  const [busy, setBusy] = useState<string | null>(null);

  const tabKey = placeTabOption(deployment.id);
  const rawTab = currentDock?.options?.[tabKey];
  const tab: PlaceTab = (PLACE_TABS as readonly string[]).includes(rawTab ?? '') ? (rawTab as PlaceTab) : 'activity';
  const chatOpen = currentDock?.options?.[PLACE_CHAT_OPTION] === deployment.id;

  const openTab = (next: string) => {
    if (currentDock) navigation.openDock(currentDock.withOption(tabKey, next === 'activity' ? null : next));
  };
  const toggleChat = () => {
    if (currentDock) navigation.openDock(currentDock.withOption(PLACE_CHAT_OPTION, chatOpen ? null : deployment.id));
  };

  const paused = deployment.status?.provider_state === 'paused';
  const name = place.is_local ? t`This computer` : t`Cloud · ${deployment.name}`;
  const meta = place.is_local ? t`Runs only while this computer is awake` : paused ? t`Paused` : t`Always on`;
  const overrideCount = Object.keys(place.overrides ?? {}).length;
  const setEnabledHere = (value: boolean) =>
    act('enabled', () => agent.setPlaceEnabled(deployment.id, value), t`Could not change where the agent runs`);
  const Icon = place.is_local ? Laptop : Cloud;

  const act = async (label: string, run: () => Promise<unknown>, failure: string) => {
    setBusy(label);
    try {
      await run();
      await onChanged();
    } catch (e) {
      notify.error({ title: failure, message: errorMessage(e, failure), forceToast: true });
    } finally {
      setBusy(null);
    }
  };

  const remove = () =>
    showDeleteAssetModal({
      name: deployment.name,
      description: t`This destroys the cloud machine. Its runs and chats on that machine are lost.`,
      onConfirm: () => act('delete', () => deployment.delete(), t`Could not delete the cloud machine`),
    });

  return (
    <article className="overflow-hidden rounded-lg border bg-background" data-testid={`agent-place-${deployment.id}`}>
      <div className="flex items-center gap-2.5 px-3.5 py-3">
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${
            place.is_local
              ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
              : 'bg-teal-500/10 text-teal-700 dark:text-teal-400'
          }`}
          aria-hidden="true"
        >
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold" data-testid="agent-place-name">
            {name}
          </div>
          <div className="truncate text-xs text-muted-foreground">{meta}</div>
        </div>
        {place.is_local ? (
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
              pendingChanges > 0
                ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
                : 'bg-green-500/15 text-green-700 dark:text-green-400'
            }`}
            data-testid="agent-place-version"
          >
            {pendingChanges > 0 ? t`${pendingChanges} not published` : t`Up to date`}
          </span>
        ) : place.behind === 0 ? (
          <span
            className="shrink-0 rounded-full bg-green-500/15 px-2 py-0.5 text-[11px] font-medium text-green-700 dark:text-green-400"
            data-testid="agent-place-version"
          >
            <Trans>Up to date</Trans>
          </span>
        ) : place.behind ? (
          <Button
            size="sm"
            variant="outline"
            className="h-6 shrink-0 rounded-full border-amber-500/40 px-2 text-[11px] text-amber-700 dark:text-amber-400"
            disabled={!!busy}
            onClick={() => void act('update', () => deployment.update(), t`Could not update the cloud machine`)}
            data-testid="agent-place-update"
          >
            {busy === 'update' ? <Loader2 className="me-1 h-3 w-3 animate-spin" /> : null}
            {t`Behind by ${place.behind} · Update`}
          </Button>
        ) : null}
        <Switch
          checked={place.enabled}
          disabled={busy === 'enabled'}
          onCheckedChange={(value) => void setEnabledHere(value)}
          aria-label={place.enabled ? t`Enabled on ${name}` : t`Disabled on ${name}`}
          title={place.enabled ? t`Runs here — switch off to stop it on this place only` : t`Off on this place`}
          data-testid="agent-place-enabled"
        />
        <Button
          size="sm"
          variant={chatOpen ? 'secondary' : 'default'}
          onClick={toggleChat}
          data-testid="agent-place-chat"
        >
          <MessageSquare className="me-1.5 h-3.5 w-3.5" />
          <Trans>Chat</Trans>
        </Button>
        {!place.is_local && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                aria-label={t`More actions for ${name}`}
                data-testid="agent-place-menu"
                disabled={!!busy}
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {paused ? (
                <DropdownMenuItem
                  onSelect={() => void act('resume', () => deployment.resume(), t`Could not resume the cloud machine`)}
                >
                  <Trans>Resume machine</Trans>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  onSelect={() => void act('pause', () => deployment.pause(), t`Could not pause the cloud machine`)}
                >
                  <Trans>Pause machine</Trans>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem className="text-destructive" onSelect={remove} data-testid="agent-place-delete">
                <Trans>Delete machine</Trans>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {chatOpen && <DeployedAgentChatPanel agent={agent} deployment={deployment} />}

      <Tabs value={tab} onValueChange={openTab}>
        <TabsList className="h-auto w-full justify-start rounded-none border-y bg-transparent px-2 py-0">
          <TabsTrigger value="activity" data-testid="agent-place-tab-activity">
            <Trans>Activity</Trans>
          </TabsTrigger>
          <TabsTrigger value="schedules" data-testid="agent-place-tab-schedules">
            <Trans>Schedules</Trans>
            {place.schedule_count > 0 && (
              <span className="ms-1.5 text-[11px] text-muted-foreground">{place.schedule_count}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="config" data-testid="agent-place-tab-config">
            <Trans>Config</Trans>
            {overrideCount > 0 && (
              <span className="ms-1.5 rounded-full bg-orange-500/15 px-1.5 text-[11px] text-orange-700 dark:text-orange-400">
                {overrideCount}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="email" data-testid="agent-place-tab-email">
            <Trans>Email</Trans>
          </TabsTrigger>
        </TabsList>
        <div className="px-3.5 py-3">
          <TabsContent value="activity" className="mt-0">
            <AgentPlaceActivity deployment={deployment} isLocal={place.is_local} />
          </TabsContent>
          <TabsContent value="schedules" className="mt-0">
            <AgentScheduleSection
              agent={agent}
              autoLaunchPrompt={autoLaunchPrompt}
              deploymentId={deployment.id}
              isLocal={place.is_local}
            />
          </TabsContent>
          <TabsContent value="config" className="mt-0">
            <AgentPlaceConfig
              agent={agent}
              deploymentId={deployment.id}
              overrides={place.overrides ?? {}}
              onChanged={onChanged}
            />
          </TabsContent>
          <TabsContent value="email" className="mt-0">
            <AgentPlaceEmail agent={agent} place={place} places={places} onChanged={onChanged} />
          </TabsContent>
        </div>
      </Tabs>
    </article>
  );
}
