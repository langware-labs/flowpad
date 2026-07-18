import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { ICompletionOptions } from '@sdk';
import { useCloudAuthed } from '@src/hooks/use-cloud-authed';
import { useCallback, useEffect, useRef, useState } from 'react';
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
  const [searchParams, setSearchParams] = useSearchParams();
  const [showLoginDialog, setShowLoginDialog] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingLoginAction | null>(null);

  const requiresLogin = agent?.site_config?.feature_flags?.require_login ?? false;
  const returnedFromLogin = searchParams.has('login') || searchParams.has('signup');
  const loginSatisfied = useCloudAuthed();
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

/**
 * Run `resume(pending)` once when the user returns from login with a pending
 * action whose `action` is in `actions`, then clear it. Consolidates the
 * post-login resume effect that consumers used to hand-wire around
 * `useLoginRequired`'s `isPostLogin` / `pendingAction` / `clearPending`.
 */
export const useResumeAfterLogin = (
  actions: ActionType | ActionType[],
  resume: (pending: PendingLoginAction) => void,
): void => {
  const { isPostLogin, pendingAction, clearPending } = useLoginRequired();
  // Keep `resume` in a ref so an unstable inline callback doesn't churn the
  // effect deps; the action guard already makes a re-run a no-op, but the ref
  // keeps it strictly fire-once per pending action.
  const resumeRef = useRef(resume);
  resumeRef.current = resume;
  useEffect(() => {
    if (!isPostLogin || !pendingAction) return;
    const list = Array.isArray(actions) ? actions : [actions];
    if (!list.includes(pendingAction.action)) return;
    resumeRef.current(pendingAction);
    clearPending();
  }, [isPostLogin, pendingAction, clearPending]); // `actions` read via closure
};
