import { useProject } from '@sdk/react/hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { createVibeProcessForProject, launchVibeSessionForProject } from './use-start-vibe-session';
import { VIBE_STARTER_PROMPTS } from './vibe-starter-prompts';
import { Loader2, Plus } from 'lucide-react';
import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

export function VibeNoProcessWorkspace() {
  const { t } = useLingui();
  const { project } = useProject();
  const { navigation } = useDockNavigation();
  const [starting, setStarting] = useState(false);
  const [startingPrompt, setStartingPrompt] = useState<string | null>(null);

  const workdir = project?.fs_storage_mount_path || project?.name || undefined;

  const startNewChat = async () => {
    if (!project?.id || starting) return;
    setStarting(true);
    try {
      await createVibeProcessForProject({
        projectId: project.id,
        workdir,
        navigation,
      });
    } catch (error) {
      console.error('[Vibe] Failed to start empty workspace session:', error);
      notify.error({ title: t`Could not start`, message: t`Failed to start the build session.` });
      setStarting(false);
    }
  };

  const startFromPrompt = async (prompt: string) => {
    if (!project?.id || startingPrompt) return;
    setStartingPrompt(prompt);
    try {
      await launchVibeSessionForProject({
        projectId: project.id,
        workdir,
        message: prompt,
        navigation,
      });
    } catch (error) {
      console.error('[Vibe] Failed to start prompted workspace session:', error);
      notify.error({ title: t`Could not start`, message: t`Failed to start the build session.` });
      setStartingPrompt(null);
    }
  };

  return (
    <div className="relative h-full w-full overflow-hidden bg-background" data-testid="vibe-no-process-workspace">
      <div className="grid h-full grid-cols-[minmax(260px,36%)_1fr]">
        <div className="relative flex h-full flex-col border-e border-border bg-muted/30">
          <div className="pointer-events-none absolute inset-0 z-10 bg-background/20" />
          <div className="flex h-10 items-center gap-2 border-b border-border px-3">
            <div className="h-2.5 w-24 rounded bg-muted-foreground/20" />
            <div className="ms-auto h-6 w-14 rounded-full border border-border bg-background/60" />
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-3 p-4 opacity-45">
            <div className="h-16 rounded-lg bg-background/70" />
            <div className="ms-auto h-12 w-3/4 rounded-lg bg-primary/10" />
            <div className="h-20 rounded-lg bg-background/70" />
            <div className="mt-auto h-11 rounded-lg border border-border bg-background/80" />
          </div>
          <div className="absolute inset-0 z-20 flex items-center justify-center p-4">
            <button
              type="button"
              onClick={() => void startNewChat()}
              disabled={!project?.id || starting || !!startingPrompt}
              data-testid="vibe-start-new-chat"
              className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              <Trans>Start new chat</Trans>
            </button>
          </div>
        </div>
        <div className="flex h-full flex-col bg-muted/20">
          <div className="flex h-10 items-center gap-2 border-b border-border px-3">
            <div className="h-2.5 w-28 rounded bg-muted-foreground/20" />
            <div className="ms-auto h-6 w-6 rounded border border-border bg-background/70" />
          </div>
          <div
            className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6 text-center"
            data-testid="display-empty-state"
          >
            <p className="text-sm text-muted-foreground">
              <Trans>Nothing to display yet — try one to get started</Trans>
            </p>
            <div className="flex max-w-md flex-wrap justify-center gap-2">
              {VIBE_STARTER_PROMPTS.map((descriptor) => {
                // One resolution per chip: the label, the key and the prompt
                // that gets sent must all be the same string.
                const p = t(descriptor);
                return (
                <button
                  key={p}
                  type="button"
                  onClick={() => void startFromPrompt(p)}
                  disabled={!project?.id || starting || !!startingPrompt}
                  data-testid="display-starter-chip"
                  className="rounded-full border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {startingPrompt === p ? <Loader2 className="me-1 inline h-3.5 w-3.5 animate-spin" /> : null}
                  {p}
                </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
