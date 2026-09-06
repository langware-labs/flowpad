import { useProject } from '@sdk/react/hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { Loader2, Plus } from 'lucide-react';
import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { VibeRecentSessions } from './vibe-recent-sessions';

/** Shared invitation to start a session on home or beside an open document. */
export function VibeNoProcessPane({
  disabled = false,
  onStartingChange,
}: {
  disabled?: boolean;
  onStartingChange?: (starting: boolean) => void;
}) {
  const { t } = useLingui();
  const { project } = useProject();
  const { navigation } = useDockNavigation();
  const [starting, setStarting] = useState(false);

  const startNewChat = async () => {
    if (!project?.id || starting || disabled) return;
    setStarting(true);
    onStartingChange?.(true);
    try {
      await navigation.startVibeSession(project.id, project.fs_storage_mount_path || project.name || undefined);
    } catch (error) {
      console.error('[Vibe] Failed to start empty workspace session:', error);
      notify.error({ title: t`Could not start`, message: t`Failed to start the build session.` });
    } finally {
      setStarting(false);
      onStartingChange?.(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 overflow-y-auto border-r border-border p-4 text-center">
      <button
        type="button"
        onClick={() => void startNewChat()}
        disabled={!project?.id || starting || disabled}
        data-testid="vibe-start-new-chat"
        className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        <Trans>Start new chat</Trans>
      </button>
      {/* Offer prior sessions without implicitly choosing one on mount. */}
      <VibeRecentSessions className="max-w-sm" heading={<Trans>Past builds</Trans>} />
    </div>
  );
}
