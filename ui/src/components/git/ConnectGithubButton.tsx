import React from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Github, Loader2 } from 'lucide-react';
import { OAUTH_PROVIDERS } from '@sdk';
import { useProviderSignIn } from '@src/components/oauth/use-provider-sign-in';
import { errorMessage } from '@src/lib/error-message';
import { Button } from '@src/components/ui/button';
import { notify } from '@src/notifications';

export interface ConnectGithubButtonProps {
  /** The grant landed — the host's "continue" (retry the share, finish the clone, …). */
  onConnected?: () => void;
  /** Starting or finishing the connection failed. Default: an error toast. */
  onError?: (message: string) => void;
  /** Button text. Default "Connect GitHub". */
  label?: React.ReactNode;
  size?: 'sm' | 'default';
  variant?: 'default' | 'outline' | 'ghost';
  className?: string;
  testId?: string;
}

/**
 * THE "Connect GitHub" button. Every git surface renders this (directly, or via
 * `GitRemoteField` inside `GitRepoPicker`) rather than its own copy of
 * `oauthService.connect` + pending state + completion listener.
 *
 * Works on hub-only pages too: it only starts the provider's OAuth flow and
 * waits for `OAUTH_FLOW_COMPLETE`, both of which the hub serves.
 *
 * The completion listener is on only while a connect is pending, so an
 * unrelated grant elsewhere never fires this host's continuation. Pending never
 * blocks anything but this button — a host must stay dismissable.
 */
export function ConnectGithubButton({
  onConnected,
  onError,
  label,
  size = 'sm',
  variant = 'outline',
  className,
  testId = 'connect-github',
}: ConnectGithubButtonProps): React.ReactElement {
  const { t } = useLingui();
  const fail = (message: string) => (onError ? onError(message) : notify.error({ title: message }));
  const { connecting: pending, signIn } = useProviderSignIn(OAUTH_PROVIDERS.GITHUB, {
    onGranted: () => onConnected?.(),
    onNotFinished: () => fail(t`The GitHub connection didn't complete.`),
    onError: (err) => fail(errorMessage(err, t`Couldn't start the GitHub connection.`)),
  });

  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      className={className}
      disabled={pending}
      onClick={() => void (pending || signIn())}
      data-testid={testId}
    >
      {pending ? <Loader2 className="me-1.5 h-3 w-3 animate-spin" /> : <Github className="me-1.5 h-3 w-3" />}
      {label ?? <Trans>Connect GitHub</Trans>}
    </Button>
  );
}

export default ConnectGithubButton;
