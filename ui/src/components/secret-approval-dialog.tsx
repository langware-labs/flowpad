import { useEffect, useRef, useState } from 'react';
import { secretApprovalGate, secretsService } from '@sdk';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@src/components/ui/alert-dialog';
import { notify } from '@src/notifications';

const TITLE = 'Allow Flowpad to use system keychain';
const DESCRIPTION =
  'Flowpad needs to store your login token and any app secrets you add in your operating system keychain. ' +
  'Approving here will trigger your OS keychain prompt — please choose Always Allow when it appears.';
const CANCEL_TOAST = { title: 'Login canceled', message: 'Keychain approval was not granted' };
const USER_CANCEL_TOAST = { title: 'Access canceled', message: 'You can enable keychain access from the warnings menu later.' };

/**
 * Globally-mounted approval dialog.
 *
 * Subscribes to `secretApprovalGate` — opens whenever any caller (currently
 * `navigator.navigateToLogin` or the warnings popover) needs to pre-flight OS
 * keychain access. Resolves the gate with the user's decision.
 */
const SecretApprovalDialog = () => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const settledRef = useRef(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    return secretApprovalGate.subscribe(() => {
      settledRef.current = false;
      setOpen(true);
    });
  }, []);

  const settle = (approved: boolean, withToast?: { title: string; message?: string }) => {
    if (settledRef.current) return;
    settledRef.current = true;
    if (withToast) notify.info(withToast);
    secretApprovalGate.resolve(approved);
    setOpen(false);
  };

  const handleApprove = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await secretsService.enable();
      if (result?.enabled) {
        // Update the cache so any subscriber (e.g. warnings popover) sees the
        // new state immediately, without waiting for a re-fetch round-trip.
        queryClient.setQueryData(['secrets-is-enabled'], { enabled: true });
        settle(true);
      } else {
        settle(false, CANCEL_TOAST);
      }
    } catch {
      settle(false, CANCEL_TOAST);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Triggered by Esc/backdrop dismiss OR by our own setOpen(false) inside settle().
        // settledRef ensures we only treat unsettled close events as a user cancel.
        if (!next && !settledRef.current) settle(false, USER_CANCEL_TOAST);
      }}
    >
      <AlertDialogContent className="sm:max-w-[440px]">
        <AlertDialogHeader>
          <AlertDialogTitle>{TITLE}</AlertDialogTitle>
          <AlertDialogDescription>{DESCRIPTION}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            onClick={(e) => {
              // Prevent Radix's default auto-close so settle() controls close + toast.
              e.preventDefault();
              settle(false, USER_CANCEL_TOAST);
            }}
            disabled={busy}
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              // Prevent Radix's default auto-close — otherwise the dialog closes
              // synchronously before the async handleApprove can flip settledRef,
              // and onOpenChange would fire a spurious "Login canceled" toast.
              e.preventDefault();
              void handleApprove();
            }}
            disabled={busy}
          >
            {busy ? 'Requesting…' : 'Approve'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export default SecretApprovalDialog;
