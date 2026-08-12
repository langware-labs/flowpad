import { cloudManager } from '@sdk';
import { LockKeyhole, LogIn } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { trackEvent } from '@src/utils/analytics';
import { usePrivacyMode } from '@src/hooks/use-privacy-mode';
import { guardCloudAction } from '@src/services/privacy-guard';

interface LoginRequiredOverlayProps {
  /** Sub-copy explaining what signing in unlocks. */
  description?: string;
}

/**
 * Soft, non-error login CTA. Rendered ON TOP of a surface that needs cloud
 * login (inbox, conversation) when the user isn't signed in. The host must be
 * `position: relative` — this fills it (`absolute inset-0`) with a translucent,
 * blurred scrim so the content stays visible behind the call-to-action.
 *
 * This is the deliberate replacement for the "Cloud sign-in expired" error
 * toast on these surfaces: being logged out is a normal state, so we show a
 * clear CTA instead of an error notification.
 */
export function LoginRequiredOverlay({
  description = 'Sign in to your Flowpad Cloud account to view and send conversations.',
}: LoginRequiredOverlayProps) {
  const { isLocal } = usePrivacyMode();

  const handleLogin = () => {
    // Defensive: the button is hidden in Local mode, but route through the
    // single guard so a stray call still surfaces the standardized notice.
    if (!guardCloudAction('login')) return;
    trackEvent({ event: 'login_clicked', event_source: 'login_required_overlay' });
    void cloudManager.login();
  };

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-background/60 backdrop-blur-sm"
      data-testid="login-required-overlay"
    >
      <div className="mx-4 flex max-w-sm flex-col items-center gap-4 rounded-xl border bg-background/95 p-6 text-center shadow-lg">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
          <LockKeyhole className="h-6 w-6 text-primary" />
        </div>
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">
            {isLocal ? 'Unavailable in Local mode' : 'Login required'}
          </h3>
          <p className="text-xs text-muted-foreground">
            {isLocal
              ? 'Conversations use Flowpad cloud, which is disabled in Local (private) data-privacy mode. Switch to Connected to sign in and share.'
              : description}
          </p>
        </div>
        {!isLocal && (
          <Button
            onClick={handleLogin}
            size="sm"
            className="w-full justify-center"
            title={cloudManager.cloudUrl ? `Logging in to ${cloudManager.cloudUrl}` : undefined}
            data-testid="login-required-overlay-button"
          >
            <LogIn className="me-2 h-4 w-4" />
            Login
          </Button>
        )}
      </div>
    </div>
  );
}

export default LoginRequiredOverlay;
