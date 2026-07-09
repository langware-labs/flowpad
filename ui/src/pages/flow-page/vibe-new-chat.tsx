import { SessionInput } from '@src/components/session-input/session-input';
import { OpenProjectComponent } from '@src/components/open-project-component/open-project-component';
import { useAuth } from '@sdk/react/hooks';
import { FolderOpen } from 'lucide-react';
import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useStartVibeSession } from './use-start-vibe-session';

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
  const { user } = useAuth();
  const startVibe = useStartVibeSession();
  const [draft, setDraft] = useState('');
  const [isProjectModalOpen, setIsProjectModalOpen] = useState(false);
  const firstName = user?.name?.split(' ')[0] || 'there';

  return (
    <div className="relative flex h-full flex-col items-center justify-center overflow-hidden px-4">
      <div
        aria-hidden
        className="vibe-hero-gradient pointer-events-none absolute inset-x-0 bottom-0 h-2/3"
      />
      <div
        className="relative z-10 flex w-full max-w-2xl flex-col items-center gap-4 text-center"
        data-testid="vibe-new-chat"
      >
        <h1 className="text-3xl font-bold tracking-tight">
          <Trans>
            Hey <span className="bg-gradient-to-r from-primary to-primary/70 bg-clip-text text-transparent">{firstName}</span>
          </Trans>
        </h1>
        <div className="w-full">
          <SessionInput
            placeholder={t`What would you like to build?`}
            value={draft}
            onChange={setDraft}
            allowAttachments
            onSubmit={(msg, files) => startVibe(msg, files)}
          />
        </div>
        <button
          type="button"
          onClick={() => setIsProjectModalOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          data-testid="vibe-open-project-folder"
        >
          <FolderOpen className="h-3.5 w-3.5 shrink-0" />
          <Trans>Open project folder</Trans>
        </button>
      </div>
      <OpenProjectComponent
        open={isProjectModalOpen}
        onOpenChange={setIsProjectModalOpen}
      />
    </div>
  );
}
