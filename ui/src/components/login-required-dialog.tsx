import { cloudManager } from '@sdk';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@src/components/ui/alert-dialog';
import { Button } from '@src/components/ui/button';
import { AlertDialogFooter } from '@src/components/ui/alert-dialog';
import { LogIn, Mail, PartyPopper, X } from 'lucide-react';
import React, { useEffect } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { trackEvent } from '../utils/analytics';
import { guardCloudAction } from '@src/services/privacy-guard';

export type LoginDialogVariant = 'require_login' | 'visitor_limit';

interface LoginDialogProps {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  variant?: LoginDialogVariant;
}

const STORAGE_KEY = 'flowpad_pending_login_action';

export enum ActionType {
  SEND = 'send',
  START_CONVERSATION = 'start_conversation',
  TOOLS = 'tools',
  CODEBASE = 'codebase',
  FILES = 'files',
  REFRESH = 'refresh',
  MEMBERS = 'members',
}

export interface PendingLoginAction {
  action: ActionType;
  message?: string;
  options?: Record<string, unknown>;
}

export const storePendingAction = (action: ActionType, message?: string, options?: Record<string, unknown>) => {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ action, message, options }));
};

export const getPendingAction = (): PendingLoginAction | null => {
  const data = sessionStorage.getItem(STORAGE_KEY);
  return data ? JSON.parse(data) : null;
};

export const clearPendingAction = () => {
  sessionStorage.removeItem(STORAGE_KEY);
};

const VARIANT_CONFIG = {
  require_login: {
    title: 'Please sign in',
    description: 'Sign in to access your flow and unlock Flowpad AI agent.',
    icon: LogIn,
    eventSource: 'require_login',
  },
  visitor_limit: {
    title: "You're doing great!",
    description: 'Create a free account to continue your conversation and save your progress.',
    icon: PartyPopper,
    eventSource: 'visitor_limit',
  },
} as const;

const GoogleIcon = () => (
  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
  </svg>
);

const LoginDialog: React.FC<LoginDialogProps> = ({ open, onOpenChange, variant = 'require_login' }) => {
  const { t } = useLingui();
  const config = VARIANT_CONFIG[variant];
  const Icon = config.icon;

  // In Local (private) mode the cloud is off-limits — never prompt to log in;
  // raise the standardized notice and close. The single guard owns the copy.
  useEffect(() => {
    if (open && !guardCloudAction('login')) {
      onOpenChange?.(false);
    }
  }, [open, onOpenChange]);

  const handleLogin = (source: string) => () => {
    if (!guardCloudAction('login')) return;
    trackEvent({ event: 'login_clicked', event_source: `${config.eventSource}_${source}` });
    void cloudManager.login();
  };
  const tooltip = cloudManager.cloudUrl ? `Logging in to ${cloudManager.cloudUrl}` : undefined;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-[400px]">
        {variant === 'require_login' && onOpenChange && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onOpenChange(false)}
            className="absolute right-3 top-3 h-8 w-8"
            aria-label={t`Close`}
          >
            <X className="h-4 w-4" />
          </Button>
        )}

        <AlertDialogHeader className="text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
            <Icon className="h-7 w-7 text-primary" />
          </div>
          <AlertDialogTitle>{config.title}</AlertDialogTitle>
          <AlertDialogDescription>{config.description}</AlertDialogDescription>
        </AlertDialogHeader>

        <AlertDialogFooter className="flex-col items-stretch gap-2 space-x-0 sm:flex-col sm:space-x-0">
          <Button
            onClick={handleLogin('google')}
            title={tooltip}
            className="w-full justify-center border border-primary"
          >
            <GoogleIcon />
            <span className="ms-2">
              <Trans>Continue with Google</Trans>
            </span>
          </Button>

          <Button variant="outline" onClick={handleLogin('email')} title={tooltip} className="w-full justify-center">
            <Mail className="h-5 w-5" />
            <span className="ms-2">
              <Trans>Continue with Email</Trans>
            </span>
          </Button>

          <p className="text-center text-xs text-muted-foreground">
            <Trans>
              By continuing, you agree to our{' '}
              <a
                href="https://flowpad.ai/terms-and-conditions"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-foreground"
              >
                Terms
              </a>{' '}
              and{' '}
              <a
                href="https://flowpad.ai/privacy-policy"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-foreground"
              >
                Privacy Policy
              </a>
              .
            </Trans>
          </p>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export default LoginDialog;
