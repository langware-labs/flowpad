import { cloudManager } from '@sdk';
import { useCloudStatus } from '@sdk/react/hooks';
import { ShieldAlert, LogIn } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { trackEvent } from '@src/utils/analytics';

/**
 * Full-viewport block for a tab left open through a shared-sandbox login
 * switch (FLOWPAD-2151): `/auth/login_callback` finding a DIFFERENT person's
 * key than whoever is signed in purges the outgoing session and broadcasts
 * `logged_out` with `reason: "switched_out"` (`clear_user_data`,
 * `flow_sdk/cli/auth/cloud_login.py`). Without this, an already-open,
 * still-connected tab just quietly re-renders as the new person's account —
 * same WS broadcast that already updates the avatar chip — with no signal to
 * the outgoing person that this happened. This sits ON TOP of the whole app
 * (mounted once in `App.tsx`, not per-surface like `LoginRequiredOverlay`)
 * and blocks interaction until they either close the tab or sign back in.
 *
 * "Log in" reuses the normal `cloudManager.login()` entry point — inside a
 * sandbox that already resolves to the personal, per-sandbox PKCE reclaim
 * flow (`start_sandbox_login`), not the delegated auto-login key, so this is
 * a real re-authentication, not a stale-credential replay. A successful login
 * flips `login.status` back to `logged_in`, which makes the overlay's own
 * condition false and it unmounts — no separate dismiss state to manage.
 */
export function SessionTakenOverOverlay() {
  const { login } = useCloudStatus();
  if (login.status !== 'logged_out' || login.reason !== 'switched_out') return null;

  const handleLogin = () => {
    trackEvent({ event: 'login_clicked', event_source: 'session_taken_over_overlay' });
    void cloudManager.login();
  };

  return (
    <div
      className="fixed inset-0 z-[100000] flex items-center justify-center bg-background/95 backdrop-blur-sm"
      data-testid="session-taken-over-overlay"
    >
      <div className="mx-4 flex max-w-sm flex-col items-center gap-4 rounded-xl border bg-background p-6 text-center shadow-lg">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
          <ShieldAlert className="h-6 w-6 text-destructive" />
        </div>
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">Someone else is using this machine</h3>
          <p className="text-xs text-muted-foreground">
            Another person signed in to this shared machine, so you were signed out. Sign back in to take it back.
          </p>
        </div>
        <Button
          onClick={handleLogin}
          size="sm"
          className="w-full justify-center"
          data-testid="session-taken-over-overlay-button"
        >
          <LogIn className="me-2 h-4 w-4" />
          Log in
        </Button>
      </div>
    </div>
  );
}

export default SessionTakenOverOverlay;
