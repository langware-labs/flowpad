import { SessionInput } from '@src/components/session-input/session-input';
import { HomeCustomBackground, HomeGreeting, useHomeCustomization } from '@src/components/home-customization';
import { ProjectActionsRow } from '@src/components/open-project-component/project-actions-row';
import { useAuth } from '@sdk/react/hooks';
import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useStartVibeSession } from './use-start-vibe-session';
import { VIBE_MODEL_DEFAULT, type VibeModelTier } from './vibe-model-select';
import { VibeRecentSessions } from './vibe-recent-sessions';

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
  const startVibe = useStartVibeSession();
  const [draft, setDraft] = useState('');
  const model: VibeModelTier = VIBE_MODEL_DEFAULT;
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
        className="relative z-10 flex w-full max-w-2xl flex-col items-center gap-4 text-center"
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
        <ProjectActionsRow className="w-full self-start" />
        <VibeRecentSessions />
      </div>
    </div>
  );
}
