import { SessionInput } from '@src/components/session-input/session-input';
import { HomeCustomBackground, HomeGreeting, useHomeCustomization } from '@src/components/home-customization';
import { ProjectActionsRow } from '@src/components/open-project-component/project-actions-row';
import { ProjectAgentsStrip } from '@src/components/agents/ProjectAgentsStrip';
import { AssetCounterRow } from '@src/components/asset-counters/AssetCounterRow';
import { appCounterGroup } from '@src/components/asset-counters/app-counters';
import { ItemsSection } from '@src/components/items/ItemsSection';
import { DESK_TABS } from '@src/components/items/home-tabs';
import { useAuth } from '@sdk/react/hooks';
import { useState } from 'react';
import { dataContext, RuntimeKind } from '@sdk';
import { useContext } from '@src/hooks/useContext';
import { ProjectApps } from '@src/components/project-home/ProjectApps';
import { QuickCreateNewSection } from '@src/components/quick-create';
import { Trans, useLingui } from '@lingui/react/macro';
import { useStartVibeSession } from './use-start-vibe-session';
import { useVibeModelTier } from './vibe-model-select';

/**
 * Vibe fallback shown when no build session is active — i.e. we're in Vibe mode
 * but not on a workspace surface (just toggled into Vibe with no running
 * process). A centered greeting-hero starter: typing a message lazily creates a
 * fresh Vibe process and opens its workspace, through the same flow as the
 * VibeHome hero (`useStartVibeSession`). Replaces the bare ContentPanel so the
 * empty Vibe surface is an invitation to start, not a blank pane.
 */
export function VibeNewChat() {
  const { t } = useLingui();
  const { currentUser } = useAuth();
  const { start: startVibe, installDialog } = useStartVibeSession();
  const [draft, setDraft] = useState('');
  // No model picker on the home: the stored tier is set from the Vibe chat pane's picker.
  const [model] = useVibeModelTier();
  const { project } = useContext();
  // A box an agent or an invite was deployed into is the agent's, not a workspace: no project pickers,
  // no create row, no catalog -- only its agents and apps, and each only when there is one.
  const deployed = [RuntimeKind.SANDBOX, RuntimeKind.AGENT].includes(dataContext.runtimeKind);
  const firstName = currentUser?.name?.split(' ')[0] || 'there';
  const { homeTitle, homeBackgroundUrl } = useHomeCustomization();

  return (
    <div className="relative flex h-full flex-col items-center justify-center overflow-hidden px-4">
      <HomeCustomBackground url={homeBackgroundUrl} />
      {/* The runtime banner used to be pinned here, absolutely positioned so it
          could sit above this centered surface. It now lives once in FlowPage,
          above the rail — which is why this surface no longer needs a special
          case for it (e2b workspaces boot into vibe mode and land here). */}
      <div aria-hidden className="vibe-hero-gradient pointer-events-none absolute inset-x-0 bottom-0 h-2/3" />
      <div
        className="relative z-10 flex w-full max-w-2xl flex-col items-center gap-4 text-center *:shrink-0"
        data-testid="vibe-new-chat"
      >
        <h1 className="text-3xl font-bold tracking-tight">
          <HomeGreeting
            override={homeTitle}
            className="bg-gradient-to-r from-primary to-primary/70 bg-clip-text text-transparent"
            fallback={
              <Trans>
                Hey{' '}
                <span className="bg-gradient-to-r from-primary to-primary/70 bg-clip-text text-transparent">
                  {firstName}
                </span>
              </Trans>
            }
          />
        </h1>
        <div className="w-full">
          <SessionInput
            placeholder={t`What would you like to work on?`}
            value={draft}
            onChange={setDraft}
            allowAttachments
            onSubmit={(msg, files) => startVibe(msg, files, model)}
          />
        </div>
        {installDialog}
        {deployed ? (
          <>
            <ProjectAgentsStrip startsNew className="w-full self-start" />
            {project && (
              <div className="w-full self-start text-left">
                <ProjectApps project={project} />
              </div>
            )}
          </>
        ) : (
          <>
            <ProjectActionsRow className="w-full self-start" />
            <QuickCreateNewSection testId="vibe-home-new" />
            <ProjectAgentsStrip startsNew className="w-full self-start" />
            <AssetCounterRow group={appCounterGroup} />
            {/* The same items section, card and filters as the hub home — only the tab list is the desk's. */}
            <div className="w-full self-start text-left">
              <ItemsSection
                tabs={DESK_TABS}
                onCreate={() => startVibe(t`Make me an agent`, [], model)}
                prefKey="desk-home"
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
