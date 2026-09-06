import { useProject } from '@sdk/react/hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { launchVibeSessionForProject } from './use-start-vibe-session';
import { VIBE_STARTER_PROMPTS } from './vibe-starter-prompts';
import { VibeNoProcessPane } from './vibe-no-process-pane';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

export function VibeNoProcessWorkspace() {
  const { t } = useLingui();
  const { project } = useProject();
  const { navigation } = useDockNavigation();
  const [starting, setStarting] = useState(false);
  const [startingPrompt, setStartingPrompt] = useState<string | null>(null);

  const workdir = project?.fs_storage_mount_path || project?.name || undefined;

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
        {/* No session OPEN here — say so, and offer the project's earlier builds.
            This pane used to render a chat-shaped GHOST (a dimming scrim, a fake
            header bar and greyed message bubbles) behind the button. Nothing is
            ever in flight on this surface, so those placeholders could never
            resolve and read as a load that hung forever (FLOWPAD-1977). An empty
            state may not imitate a skeleton.

            Landing here does NOT auto-resume a past build: "open a project on
            home stays home" is a deliberate invariant, pinned by
            tests/unit/use-project-opener-home-stay.test.tsx. So the history is
            OFFERED (one click) rather than entered — which is also why the
            project's builds have to be reachable from this pane at all, instead
            of only from the Chats rail icon.

            No standalone "no session" caption: it is a claim about EXISTENCE
            that the "Past builds" list directly below it contradicts whenever
            the project has any. The action and the labelled list carry the
            state on their own, in both the empty and populated case. */}
        <VibeNoProcessPane disabled={!!startingPrompt} onStartingChange={setStarting} />
        <div className="flex h-full flex-col bg-muted/20">
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
