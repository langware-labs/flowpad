import { Trans } from '@lingui/react/macro';
import { navigator } from '@sdk';
import { Button } from '@src/components/ui/button';
import { cn } from '@src/lib/utils';
import { LogIn } from 'lucide-react';
import React from 'react';

interface LoginRequiredPanelProps {
  message?: React.ReactNode;
  className?: string;
}

/** Shown in place of a surface that needs a signed-in user. */
export const LoginRequiredPanel: React.FC<LoginRequiredPanelProps> = ({ message, className }) => (
  <div
    className={cn(
      'flex h-full flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-border p-6 text-center',
      className,
    )}
    data-testid="login-required"
  >
    <LogIn className="h-10 w-10 text-muted-foreground" />
    <div>
      <h2 className="text-lg font-semibold">
        <Trans>Login Required</Trans>
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {message ?? <Trans>Please log in to manage credentials.</Trans>}
      </p>
    </div>
    <Button onClick={() => void navigator.navigateToLogin()} className="px-6">
      <Trans>Login</Trans>
    </Button>
  </div>
);
