import { DEFAULT_CREDENTIAL_ENVIRONMENT, type Agent, type Deployment, type Project } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { Loader2, MessageSquare, MoreHorizontal } from 'lucide-react';

import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@src/components/ui/tabs';
import { showDeleteAssetModal } from '@src/components/assets/delete-asset-modal';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { AgentPlaceActivity } from '@src/components/assets/editor/agent-profile/AgentPlaceActivity';
import { AgentPlaceConfig } from '@src/components/assets/editor/agent-profile/AgentPlaceConfig';
import { AgentPlaceSecrets } from '@src/components/assets/editor/agent-profile/AgentPlaceSecrets';
import { DeployedAgentChatPanel } from '@src/components/assets/editor/agent-profile/DeployedAgentChatPanel';
import { PROJECT_DEPLOYMENT_OPTION } from './project-deployments-url';

const TABS = ['activity', 'config', 'secrets'] as const;
type CardTab = (typeof TABS)[number];
/** Dock options: the selected tab, and whether the main agent's chat is open. */
const TAB_OPTION = 'tab';
const CHAT_OPTION = 'chat';

interface ProjectDeploymentCardProps {
  project: Project;
  deployment: Deployment;
  /** Its main agent, when it has one (chat and config are the agent's). */
  mainAgent: Agent | null;
}

/**
 * How one deployment of a project is run: its environment and source, Update to a new ref, Pause / Resume,
 * Delete, a Chat with its main agent, and its Activity, Config (the main agent's overrides here) and Secrets.
 * The tab and the open chat live in the URL — a click only navigates.
 */
export function ProjectDeploymentCard({ project, deployment, mainAgent }: ProjectDeploymentCardProps) {
  const { t } = useLingui();
  const { navigation, currentDock } = useDockNavigation();
  const [busy, setBusy] = useState<string | null>(null);
  const [ref, setRef] = useState('');
  const local = deployment.isLocal;

  const rawTab = currentDock?.options?.[TAB_OPTION];
  const tab: CardTab = (TABS as readonly string[]).includes(rawTab ?? '') ? (rawTab as CardTab) : 'activity';
  const chatOpen = !!mainAgent && currentDock?.options?.[CHAT_OPTION] === deployment.id;
  const openTab = (next: string) =>
    currentDock && navigation.openDock(currentDock.withOption(TAB_OPTION, next === 'activity' ? null : next));
  const toggleChat = () =>
    currentDock && navigation.openDock(currentDock.withOption(CHAT_OPTION, chatOpen ? null : deployment.id));

  const paused = deployment.status?.provider_state === 'paused';
  const overrideCount = Object.keys(deployment.main_agent_overrides ?? {}).length;

  const act = async (label: string, run: () => Promise<unknown>, failure: string) => {
    setBusy(label);
    try {
      await run();
    } catch (e) {
      notify.error({ title: failure, message: errorMessage(e, failure), forceToast: true });
    } finally {
      setBusy(null);
    }
  };

  const update = () =>
    act(
      'update',
      async () => {
        await deployment.update(ref.trim() ? { kind: deployment.source_kind, ref: ref.trim() } : {});
        setRef('');
      },
      t`Could not update the deployment`,
    );

  const remove = () =>
    showDeleteAssetModal({
      name: deployment.name,
      description: local
        ? t`This stops the project on this computer.`
        : t`This destroys the cloud machine. Its runs and chats on that machine are lost.`,
      onConfirm: () =>
        act(
          'delete',
          async () => {
            await deployment.delete();
            // The URL still names the deployment just deleted: back to the project's list.
            if (currentDock?.options?.[PROJECT_DEPLOYMENT_OPTION] === deployment.id)
              navigation.openDock(currentDock.withOption(PROJECT_DEPLOYMENT_OPTION, null));
          },
          t`Could not delete the deployment`,
        ),
    });

  return (
    <article className="overflow-hidden rounded-lg border bg-background" data-testid={`project-deployment-card-${deployment.id}`}>
      <div className="flex flex-wrap items-center gap-2.5 px-3.5 py-2.5">
        <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground" data-testid="project-deployment-meta">
          {local ? t`Runs only while this computer is awake` : paused ? t`Paused` : t`Always on`}
        </div>
        <span
          className="shrink-0 rounded-full border px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
          title={t`Credential environment this deployment reads`}
          data-testid="project-deployment-environment"
        >
          {deployment.environment || DEFAULT_CREDENTIAL_ENVIRONMENT}
        </span>
        {!local && (
          <>
            <Input
              className="h-7 w-36 font-mono text-[11px]"
              value={ref}
              placeholder={deployment.source_ref ?? deployment.source_kind}
              aria-label={t`Update to`}
              disabled={!!busy}
              onChange={(e) => setRef(e.target.value)}
              data-testid="project-deployment-update-ref"
            />
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              disabled={!!busy}
              onClick={() => void update()}
              data-testid="project-deployment-update"
            >
              {busy === 'update' && <Loader2 className="me-1 h-3 w-3 animate-spin" />}
              <Trans>Update</Trans>
            </Button>
          </>
        )}
        {mainAgent && (
          <Button size="sm" variant={chatOpen ? 'secondary' : 'default'} onClick={toggleChat} data-testid="project-deployment-chat">
            <MessageSquare className="me-1.5 h-3.5 w-3.5" />
            <Trans>Chat</Trans>
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t`More actions for ${deployment.name}`}
              data-testid="project-deployment-menu"
              disabled={!!busy}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {paused ? (
              <DropdownMenuItem
                onSelect={() => void act('resume', () => deployment.resume(), t`Could not resume the deployment`)}
                data-testid="project-deployment-resume"
              >
                <Trans>Resume</Trans>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                onSelect={() => void act('pause', () => deployment.pause(), t`Could not pause the deployment`)}
                data-testid="project-deployment-pause"
              >
                <Trans>Pause</Trans>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem className="text-destructive" onSelect={remove} data-testid="project-deployment-delete">
              <Trans>Delete</Trans>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {chatOpen && mainAgent && <DeployedAgentChatPanel agent={mainAgent} deployment={deployment} />}

      <Tabs value={tab} onValueChange={openTab}>
        <TabsList className="h-auto w-full justify-start rounded-none border-y bg-transparent px-2 py-0">
          <TabsTrigger value="activity" data-testid="project-deployment-tab-activity">
            <Trans>Activity</Trans>
          </TabsTrigger>
          {mainAgent && (
            <TabsTrigger value="config" data-testid="project-deployment-tab-config">
              <Trans>Config</Trans>
              {overrideCount > 0 && (
                <span className="ms-1.5 rounded-full bg-orange-500/15 px-1.5 text-[11px] text-orange-700 dark:text-orange-400">
                  {overrideCount}
                </span>
              )}
            </TabsTrigger>
          )}
          {!local && (
            <TabsTrigger value="secrets" data-testid="project-deployment-tab-secrets">
              <Trans>Secrets</Trans>
            </TabsTrigger>
          )}
        </TabsList>
        <div className="px-3.5 py-3">
          <TabsContent value="activity" className="mt-0">
            <AgentPlaceActivity deployment={deployment} isLocal={local} />
          </TabsContent>
          {mainAgent && (
            <TabsContent value="config" className="mt-0">
              <AgentPlaceConfig agent={mainAgent} deployment={deployment} onChanged={() => undefined} />
            </TabsContent>
          )}
          {!local && (
            <TabsContent value="secrets" className="mt-0">
              <AgentPlaceSecrets project={project} deployment={deployment} />
            </TabsContent>
          )}
        </div>
      </Tabs>
    </article>
  );
}
