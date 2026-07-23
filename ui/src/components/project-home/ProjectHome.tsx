import { MembersAvatarStack } from '@src/components/conversation/MembersAvatarStack';
import { MiniDesktop, QuickCreatePanel, TileSection, useQuickCreatePick } from '@src/components/quick-create';
import type { PanelHandlers } from '@src/components/quick-create';
import { SecretsCard } from './SecretsCard';
import { HomeCustomizationCard } from './HomeCustomizationCard';
import { VIBE_AGENTS_TOPIC, VibeAgentsCard } from './VibeAgentsCard';
import { useHighlight } from '@src/components/wiki-tip/highlight';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@src/components/ui/tabs';
import { useContext as useDataContext } from '@src/hooks/useContext';
import { WorkerToolbar } from '@src/components/workers/WorkerToolbar';
import { useTerminalStripController } from '@src/tabs/useTerminalStripController';
import { projectScope } from '@src/lib/scope-filter';
import { Project, TypeId } from '@sdk';
import { topicTag } from '@src/topics/topic-tag';
import React, { useEffect, useMemo, useState } from 'react';
import { Trans } from '@lingui/react/macro';

/** Journey anchor for the session launcher (`?highlight=NewSession`). */
const NEW_SESSION_TOPIC = 'NewSession';

interface ProjectHomeProps {
  /** Pin spawned shells/processes to this project; otherwise the active project. */
  spawnProjectId?: string | null;
  /** Render only the "Create" body with no tab bar — the terminal empty state,
   *  whose whole point is to start something. The landing shows all three tabs. */
  createOnly?: boolean;
}

/**
 * HarnessLauncher — the single worker-launch affordance on the project home:
 * the shared `WorkerToolbar` (claude / codex / copilot) plus the controller's
 * own `terminal` opener. Replaces the old duplicated launchers (the "No
 * terminal sessions" pills and the QuickCreatePanel "New session" tiles).
 * Encapsulates `useTerminalStripController` so its controller + modals run
 * once, here.
 *
 * Terminal rides in as an `OpenerDescriptor` rather than a bespoke prop: it
 * isn't a coding-agent vendor, so it must stay out of `LAUNCHABLE_WORKERS`
 * (which every other surface renders), and the descriptor already carries its
 * label, glyph and in-flight state.
 */
const HarnessLauncher: React.FC<{ spawnProjectId?: string | null }> = ({ spawnProjectId }) => {
  const { modals, isTabCreationPending, startWorker, openers } = useTerminalStripController({ spawnProjectId });

  const terminalOpener = useMemo(() => openers.filter((o) => o.id === 'terminal'), [openers]);

  return (
    <div data-testid="project-home-start-session" {...topicTag(NEW_SESSION_TOPIC, 'button')}>
      <TileSection title={<Trans>New session</Trans>}>
        <WorkerToolbar
          onLaunch={startWorker}
          starting={isTabCreationPending}
          extraOpeners={terminalOpener}
          mode="all"
          testIdPrefix="project-home-worker"
        />
      </TileSection>
      {modals}
    </div>
  );
};

/** The "Create" body — the harness launcher, the favorites mini-desktop, and
 *  the New asset / New folder tiles. Its own component so the tabbed landing
 *  and the terminal empty state share one definition. */
const CreateTab: React.FC<{
  projectId: string | null;
  spawnProjectId?: string | null;
  panelProps: PanelHandlers;
}> = ({ projectId, spawnProjectId, panelProps }) => (
  <div className="flex flex-col gap-6">
    {projectId && <HarnessLauncher spawnProjectId={spawnProjectId} />}
    <MiniDesktop scope={projectId ? projectScope(projectId) : undefined} panelProps={panelProps} />
    <QuickCreatePanel {...panelProps} sections={['asset', 'folder']} />
  </div>
);

/** Which tab hosts which topic word — see the `?highlight=` effect below.
 *  Add an entry whenever a card on a non-default tab takes a `topicTag`. */
const TAB_FOR_TOPIC: Record<string, string> = {
  [VIBE_AGENTS_TOPIC]: 'customize',
};

/**
 * ProjectHome — the project's landing surface, shown wherever a project has no
 * open content: the terminal body's empty state (no terminal sessions) and the
 * project-home content slot (no asset/item selected). The one surface that is
 * unambiguously "the project itself" rather than content inside it.
 *
 * Organized into three tabs:
 *   - **Create**    — the harness launcher (workers + terminal), the mini
 *                     desktop of favorites, and the New asset / New folder tiles.
 *   - **Customize** — home title/background + the vibe agents layered on.
 *   - **Secrets**   — value-free secret references + setup wizard.
 */
export const ProjectHome: React.FC<ProjectHomeProps> = ({ spawnProjectId, createOnly = false }) => {
  const dataCtx = useDataContext();

  // Resolve the target project (explicit spawn pin, else the active project).
  const projectId = spawnProjectId ?? dataCtx.project?.id ?? null;
  const projectTypeId = useMemo(
    () => (projectId ? new TypeId(Project.type, projectId) : null),
    [projectId],
  );

  // The dialogs the create tiles defer to. Hosted here rather than in the panel
  // so they outlive whatever the tile click dismisses — and threaded into
  // MiniDesktop so this surface mounts exactly one instance of them.
  const { panelProps, dialogs } = useQuickCreatePick();

  // Customize/Secrets cards are project-entity bound — only when the resolved
  // project is the active one (they read/write live Project state).
  const project = dataCtx.project?.id === projectId ? dataCtx.project : null;

  const createTab = <CreateTab projectId={projectId} spawnProjectId={spawnProjectId} panelProps={panelProps} />;

  // A `?highlight=` target that lives on a tab we aren't showing would never
  // mount, so the generic TopicHighlightObserver would find nothing — open the
  // owning tab instead. Each tab declares the topic words it hosts.
  const [tab, setTab] = useState('create');
  const highlight = useHighlight();
  useEffect(() => {
    const owner = highlight ? TAB_FOR_TOPIC[highlight] : undefined;
    if (owner) setTab(owner);
  }, [highlight]);

  return (
    <div className="flex h-full flex-col">
      {/* Members — project-level roster + invite (role-gated inside the stack). */}
      {projectTypeId && (
        <div
          className="flex items-center justify-between border-b border-border/50 px-4 py-2"
          data-testid="project-home-members"
        >
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <Trans>Members</Trans>
          </span>
          <MembersAvatarStack typeId={projectTypeId} allowInviteLink />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full flex-col gap-6 px-4 py-6">
          {createOnly ? (
            createTab
          ) : (
            <Tabs value={tab} onValueChange={setTab} data-testid="project-home-tabs">
              <TabsList>
                <TabsTrigger value="create" data-testid="project-home-tab-create">
                  <Trans>Create</Trans>
                </TabsTrigger>
                <TabsTrigger value="customize" data-testid="project-home-tab-customize">
                  <Trans>Customize</Trans>
                </TabsTrigger>
                <TabsTrigger value="secrets" data-testid="project-home-tab-secrets">
                  <Trans>Secrets</Trans>
                </TabsTrigger>
              </TabsList>

              <TabsContent value="create">{createTab}</TabsContent>

              <TabsContent value="customize" className="flex flex-col gap-6">
                {project && (
                  <>
                    <HomeCustomizationCard project={project} />
                    <VibeAgentsCard project={project} />
                  </>
                )}
              </TabsContent>

              <TabsContent value="secrets">{project && <SecretsCard project={project} />}</TabsContent>
            </Tabs>
          )}
        </div>
      </div>
      {dialogs}
    </div>
  );
};
