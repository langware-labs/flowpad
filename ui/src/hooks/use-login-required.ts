import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { ICompletionOptions } from '@sdk';
import { useAuth, useContext as useSdkContext } from '@sdk/react/hooks';
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
  checkLoginAndProceed: (
    action: ActionType,
    message?: string,
    options?: ICompletionOptions,
    guardOptions?: LoginGuardOptions,
  ) => boolean;
  pendingAction: PendingLoginAction | null;
  clearPending: () => void;
  isPostLogin: boolean;
}

interface LoginGuardOptions {
  forceLogin?: boolean;
}

export const useLoginRequired = (): UseLoginRequiredReturn => {
  const { agent } = useAgentContext();
  const { user, cloudUser } = useAuth();
  const { cloudLoginAvailable, isDesktop } = useSdkContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const [showLoginDialog, setShowLoginDialog] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingLoginAction | null>(null);

  const requiresLogin = agent?.site_config?.feature_flags?.require_login ?? false;
  const returnedFromLogin = searchParams.has('login') || searchParams.has('signup');
  const loginSatisfied = isDesktop ? Boolean(cloudLoginAvailable || cloudUser) : Boolean(user);
  const isPostLogin = returnedFromLogin || Boolean(loginSatisfied && pendingAction);

  // On mount and when returning from login, check for pending action
  useEffect(() => {
    if ((returnedFromLogin || loginSatisfied) && loginSatisfied) {
      const pending = getPendingAction();
      if (pending) {
        setPendingAction(pending);
        setShowLoginDialog(false);
      }
    }
    if (returnedFromLogin) {
      // Clean up query params
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('login');
      newParams.delete('signup');
      setSearchParams(newParams, { replace: true });
    }
  }, [returnedFromLogin, loginSatisfied, searchParams, setSearchParams]);

  const checkLoginAndProceed = useCallback(
    (
      action: ActionType,
      message?: string,
      options?: ICompletionOptions,
      guardOptions?: LoginGuardOptions,
    ): boolean => {
      const shouldRequireLogin = guardOptions?.forceLogin || requiresLogin;
      // If user is logged in or login not required, proceed
      if (loginSatisfied || !shouldRequireLogin) {
        return true;
      }

      // Store pending action for after login
      storePendingAction(action, message, options as Record<string, unknown>);
      setShowLoginDialog(true);
      return false;
    },
    [loginSatisfied, requiresLogin],
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
