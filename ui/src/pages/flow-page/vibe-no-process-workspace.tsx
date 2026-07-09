import { useProject } from '@sdk/react/hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { createVibeProcessForProject } from './use-start-vibe-session';
import { Loader2, Plus } from 'lucide-react';
import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

export function VibeNoProcessWorkspace() {
  const { t } = useLingui();
  const { project } = useProject();
  const { navigation } = useDockNavigation();
  const [starting, setStarting] = useState(false);

  const startNewChat = async () => {
    if (!project?.id || starting) return;
    setStarting(true);
    try {
      await createVibeProcessForProject({
        projectId: project.id,
        workdir: project.fs_storage_mount_path || project.name || undefined,
        navigation,
      });
    } catch (error) {
      console.error('[Vibe] Failed to start empty workspace session:', error);
      notify.error({ title: t`Could not start`, message: t`Failed to start the build session.` });
      setStarting(false);
    }
  };

  return (
    <div className="relative h-full w-full overflow-hidden bg-background" data-testid="vibe-no-process-workspace">
      <div className="grid h-full grid-cols-[minmax(260px,36%)_1fr] opacity-45">
        <div className="flex h-full flex-col border-r border-border bg-muted/30">
          <div className="flex h-10 items-center gap-2 border-b border-border px-3">
            <div className="h-2.5 w-24 rounded bg-muted-foreground/20" />
            <div className="ml-auto h-6 w-14 rounded-full border border-border bg-background/60" />
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
            <div className="h-16 rounded-lg bg-background/70" />
            <div className="ml-auto h-12 w-3/4 rounded-lg bg-primary/10" />
            <div className="h-20 rounded-lg bg-background/70" />
            <div className="mt-auto h-11 rounded-lg border border-border bg-background/80" />
          </div>
        </div>
        <div className="flex h-full flex-col bg-muted/20">
          <div className="flex h-10 items-center gap-2 border-b border-border px-3">
            <div className="h-2.5 w-28 rounded bg-muted-foreground/20" />
            <div className="ml-auto h-6 w-6 rounded border border-border bg-background/70" />
          </div>
          <div className="grid min-h-0 flex-1 place-items-center p-8">
            <div className="h-2/3 w-2/3 max-w-2xl rounded-lg border border-border bg-background/50" />
          </div>
        </div>
      </div>
      <div className="absolute inset-0 flex items-center justify-center">
        <button
          type="button"
          onClick={() => void startNewChat()}
          disabled={!project?.id || starting}
          data-testid="vibe-start-new-chat"
          className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          <Trans>Start new chat</Trans>
        </button>
      </div>
    </div>
  );
}
