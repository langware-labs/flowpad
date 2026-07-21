import { SessionInput } from '@src/components/session-input/session-input';
import { HomeCustomBackground, HomeGreeting, useHomeCustomization } from '@src/components/home-customization';
import { OpenProjectComponent } from '@src/components/open-project-component/open-project-component';
import { normalizePath, useProjectOpener } from '@src/components/open-project-component/use-open-project';
import { NewProjectDialog } from '@src/components/project-selector';
import { notify } from '@src/notifications';
import { dataContext } from '@sdk';
import { useAuth } from '@sdk/react/hooks';
import { FolderOpen, FolderPlus, FolderSearch, Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useStartVibeSession } from './use-start-vibe-session';
import { VIBE_MODEL_DEFAULT, VibeModelSelect, type VibeModelTier } from './vibe-model-select';
import { VibeWorkerSelect } from './vibe-worker-select';
import { VibeRecentSessions } from './vibe-recent-sessions';
import { DEFAULT_WORKER_TYPE, type WorkerType } from '@src/components/workers/worker-types';

/** Shared ghost-button style for the two under-input project actions. */
const PROJECT_ACTION_BUTTON_CLASS =
  'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50';

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
  const [model, setModel] = useState<VibeModelTier>(VIBE_MODEL_DEFAULT);
  const [workerType, setWorkerType] = useState<WorkerType>(DEFAULT_WORKER_TYPE);
  const [isProjectModalOpen, setIsProjectModalOpen] = useState(false);
  const [isNewProjectOpen, setIsNewProjectOpen] = useState(false);
  const [isOpeningFolder, setIsOpeningFolder] = useState(false);
  const firstName = currentUser?.name?.split(' ')[0] || 'there';
  const { homeTitle, homeBackgroundUrl } = useHomeCustomization();
  const defaultWorkspacePath = useMemo(
    () => dataContext.bootstrapInfo?.desktop_info?.paths?.workspace || '',
    [],
  );

  // On vibe home, opening/switching a project just changes the project and
  // lands on the fresh vibe home (never resumes an old build process) — that
  // decision lives inside useProjectOpener, derived from the current surface.
  const { openProjectFolder, pickFolder, ensureProjectAndSetContext } = useProjectOpener({
    onError: (message) => notify.error({ title: message }),
  });

  const handleOpenFolder = async () => {
    // openProjectFolder never throws — it routes failures through onError.
    setIsOpeningFolder(true);
    try {
      await openProjectFolder();
    } finally {
      setIsOpeningFolder(false);
    }
  };

  return (
    <div className="relative flex h-full flex-col items-center justify-center overflow-hidden px-4">
      <HomeCustomBackground url={homeBackgroundUrl} />
      <div
        aria-hidden
        className="vibe-hero-gradient pointer-events-none absolute inset-x-0 bottom-0 h-2/3"
      />
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
                Hey <span className="bg-gradient-to-r from-primary to-primary/70 bg-clip-text text-transparent">{firstName}</span>
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
            footerSlot={(
              <div className="flex flex-wrap items-center gap-1.5">
                <VibeModelSelect value={model} onChange={setModel} />
                <VibeWorkerSelect value={workerType} onChange={setWorkerType} />
              </div>
            )}
            onSubmit={(msg, files) => startVibe(msg, files, model, workerType)}
          />
        </div>
        <div className="flex w-full items-center gap-1.5 self-start">
          <button
            type="button"
            onClick={() => void handleOpenFolder()}
            disabled={isOpeningFolder}
            className={PROJECT_ACTION_BUTTON_CLASS}
            data-testid="vibe-open-project-folder"
          >
            {isOpeningFolder ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            ) : (
              <FolderOpen className="h-3.5 w-3.5 shrink-0" />
            )}
            <Trans>Open folder</Trans>
          </button>
          <button
            type="button"
            onClick={() => setIsProjectModalOpen(true)}
            className={PROJECT_ACTION_BUTTON_CLASS}
            data-testid="vibe-open-existing-project"
          >
            <FolderSearch className="h-3.5 w-3.5 shrink-0" />
            <Trans>Open existing project</Trans>
          </button>
          <button
            type="button"
            onClick={() => setIsNewProjectOpen(true)}
            className={PROJECT_ACTION_BUTTON_CLASS}
            data-testid="vibe-new-project"
          >
            <FolderPlus className="h-3.5 w-3.5 shrink-0" />
            <Trans>New project</Trans>
          </button>
        </div>
        <VibeRecentSessions />
      </div>
      <OpenProjectComponent open={isProjectModalOpen} onOpenChange={setIsProjectModalOpen} />
      <NewProjectDialog
        open={isNewProjectOpen}
        onOpenChange={setIsNewProjectOpen}
        defaultParentFolder={defaultWorkspacePath}
        onPickFolder={() => pickFolder(defaultWorkspacePath || undefined)}
        onCreate={async (name, parentFolder) => {
          await ensureProjectAndSetContext(`${normalizePath(parentFolder)}/${name}`);
        }}
      />
    </div>
  );
}
