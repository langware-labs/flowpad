import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { secretApprovalGate } from '@sdk';

/**
 * Bridge page for the deep-link auth flow when keychain access has not yet
 * been approved. The Electron-loaded `/auth/login_callback` redirects here
 * (preserving `flowpad-api-key` + `next`) so we can provision keychain access
 * (via secretApprovalGate.request) before the OS keychain prompt fires from
 * `_finalize_login`. On success, we re-invoke the original callback and let
 * the server finalize the login.
 */
const KeychainApproval = () => {
  const [params] = useSearchParams();
  const apiKey = params.get('flowpad-api-key') ?? '';
  const next = params.get('next') ?? '';
  const [state, setState] = useState<'requesting' | 'canceled'>('requesting');
  const requestedRef = useRef(false);

  const requestApproval = useCallback(() => {
    setState('requesting');
    void secretApprovalGate.request().then((approved) => {
      if (approved) {
        const qs = new URLSearchParams();
        if (apiKey) qs.set('flowpad-api-key', apiKey);
        if (next) qs.set('next', next);
        window.location.href = `/auth/login_callback?${qs.toString()}`;
      } else {
        setState('canceled');
      }
    });
  }, [apiKey, next]);

  useEffect(() => {
    if (requestedRef.current) return;
    requestedRef.current = true;
    if (!apiKey) {
      setState('canceled');
      return;
    }
    requestApproval();
  }, [apiKey, requestApproval]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-100 p-6">
      <div className="max-w-md text-center">
        {state === 'requesting' ? (
          <>
            <div className="mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-b-2 border-ring" />
            <p className="text-gray-700">Waiting for keychain approval…</p>
          </>
        ) : (
          <>
            <h1 className="mb-3 text-2xl font-semibold">Login canceled</h1>
            <p className="mb-6 text-gray-600">
              {apiKey
                ? 'Keychain access is required to finish signing in to Flowpad.'
                : 'Missing API key — please retry the deep link from the source page.'}
            </p>
            {apiKey && (
              <button
                onClick={requestApproval}
                className="rounded-md bg-primary px-4 py-2 text-primary-foreground hover:opacity-90"
              >
                Try again
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default KeychainApproval;
