import { useLingui } from '@lingui/react/macro';
import { Hourglass } from 'lucide-react';
import { useSurfaceSwitchWait } from './use-process-surface';

/**
 * Says why a session has not switched to chat/vibe yet. Chat/vibe and the
 * terminal are mutually exclusive, so the switch kills the PTY — and while the
 * agent is mid-turn, or background work it launched still runs there, that
 * would kill the work with it. `useProcessSurface` holds the switch back and the
 * terminal stays on screen; without this line the user's click looks ignored.
 */
export function SurfaceSwitchWaitNotice({ processId }: { processId: string | null | undefined }) {
  const { t } = useLingui();
  const wait = useSurfaceSwitchWait(processId);
  // `switching` is a request in flight — too brief to explain.
  if (!wait || wait === 'switching') return null;
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b bg-background px-4 py-2 text-[13px] text-foreground"
      data-testid="surface-switch-wait-notice"
      data-wait={wait}
    >
      <Hourglass className="h-4 w-4 flex-shrink-0 animate-pulse text-amber-400" />
      <span>
        {wait === 'background'
          ? t`Background tasks are still running. The session will switch over as soon as they finish.`
          : t`The agent is still working, or waiting for your answer in the terminal. The session will switch over as soon as it finishes.`}
      </span>
    </div>
  );
}
