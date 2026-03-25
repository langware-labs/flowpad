import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { ICompletionOptions } from '@sdk';
import { useAuth } from '@sdk/react/hooks';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  ActionType,
  clearPendingAction,
  getPendingAction,
  PendingLoginAction,
  storePendingAction,
} from '../components/login-required-dialog';

interface UseLoginRequiredReturn {
  showLoginDialog: boolean;
  closeLoginDialog: () => void;
  requiresLogin: boolean;
  checkLoginAndProceed: (action: ActionType, message?: string, options?: ICompletionOptions) => boolean;
  pendingAction: PendingLoginAction | null;
  clearPending: () => void;
  isPostLogin: boolean;
}

export const useLoginRequired = (): UseLoginRequiredReturn => {
  const { agent } = useAgentContext();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [showLoginDialog, setShowLoginDialog] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingLoginAction | null>(null);

  const requiresLogin = agent?.site_config?.feature_flags?.require_login ?? false;
  const isPostLogin = searchParams.has('login') || searchParams.has('signup');

  // On mount and when returning from login, check for pending action
  useEffect(() => {
    if (isPostLogin && user) {
      const pending = getPendingAction();
      if (pending) {
        setPendingAction(pending);
      }
      // Clean up query params
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('login');
      newParams.delete('signup');
      setSearchParams(newParams, { replace: true });
    }
  }, [isPostLogin, user, searchParams, setSearchParams]);

  const checkLoginAndProceed = useCallback(
    (action: ActionType, message?: string, options?: ICompletionOptions): boolean => {
      // If user is logged in or login not required, proceed
      if (user || !requiresLogin) {
        return true;
      }

      // Store pending action for after login
      storePendingAction(action, message, options as Record<string, unknown>);
      setShowLoginDialog(true);
      return false;
    },
    [user, requiresLogin],
  );

  const closeLoginDialog = useCallback(() => {
    setShowLoginDialog(false);
  }, []);

  const clearPending = useCallback(() => {
    clearPendingAction();
    setPendingAction(null);
  }, []);

  return {
    showLoginDialog,
    closeLoginDialog,
    requiresLogin,
    checkLoginAndProceed,
    pendingAction,
    clearPending,
    isPostLogin,
  };
};
