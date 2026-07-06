import { SessionInput } from '@src/components/session-input/session-input';
import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useStartVibeSession } from './use-start-vibe-session';

/**
 * Vibe fallback shown when no build session is active — i.e. we're in Vibe mode
 * but not on a workspace surface (just toggled into Vibe with no running
 * process). A centered "New chat" starter: typing a message lazily creates a
 * fresh Vibe process and opens its workspace, through the same flow as the
 * VibeHome hero (`useStartVibeSession`). Replaces the bare ContentPanel so the
 * empty Vibe surface is an invitation to start, not a blank pane.
 */
export function VibeNewChat() {
  const { t } = useLingui();
  const startVibe = useStartVibeSession();
  const [draft, setDraft] = useState('');

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
          <Trans>New chat</Trans>
        </h1>
        <div className="w-full">
          <SessionInput
            placeholder={t`What would you like to build?`}
            value={draft}
            onChange={setDraft}
            onSubmit={(msg) => startVibe(msg)}
          />
        </div>
      </div>
    </div>
  );
}
