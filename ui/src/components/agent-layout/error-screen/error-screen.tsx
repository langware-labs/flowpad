import { NotFoundError } from '@src/errors/NotFoundError';
import NotFound from '@src/pages/NotFound';
import { Button } from '@src/components/ui/button';
import { ChevronDown, ChevronUp, Home } from 'lucide-react';
import { useState } from 'react';
import { useRouteError } from 'react-router';
import { isBackendUnreachable } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';

/** The loosely-typed shape this screen reads off an unknown route error. */
interface ErrorLike {
  status?: number;
  message?: string;
  response?: { status?: number; data?: { message?: string } };
}

const ErrorScreen = () => {
  const { t } = useLingui();
  const error = useRouteError();
  const [showDetails, setShowDetails] = useState(false);

  // `useRouteError` is `unknown`; the 404 and message branches below read it
  // structurally. This declaration was MISSING — every render that reached
  // those branches threw `ReferenceError: errorAny is not defined`, so the
  // error boundary itself crashed and a failed route showed a blank page
  // instead of this screen. Found by the dock sweep, which navigates to docks
  // whose target does not exist.
  const errorAny = (error ?? null) as ErrorLike | null;

  // ERROR HIERARCHY (check in this exact order):

  // 1. Is the BACKEND actually unreachable?
  //
  // Only a connectivity failure earns this screen. It used to treat any status
  // >= 500 as "backend not responding", so a single unsupported action — a hub
  // answering 500 "Action list is not allowed" to one repo call — blanked the
  // whole app and told the user to check whether their server was running,
  // while every other request on the page was succeeding. A 5xx means one
  // request failed; it does not mean the server is gone. The classification
  // lives with the interceptor that makes it (ts_sdk/client.ts).
  const isServiceUnavailable = isBackendUnreachable(error);

  const [dismissed, setDismissed] = useState(false);

  if (isServiceUnavailable && !dismissed) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
        <div className="w-full max-w-md rounded-lg bg-background/95 p-8 text-center shadow-xl">
          <div className="mb-6">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-orange-100">
              <svg className="h-8 w-8 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
            </div>
            <h1 className="mb-2 text-2xl font-bold">
              <Trans>Service Unavailable</Trans>
            </h1>
            <p className="text-muted-foreground">
              <Trans>Backend server is not responding. Please try again later.</Trans>
            </p>
          </div>
          <Button onClick={() => setDismissed(true)} className="w-full" variant="outline">
            <Trans>OK</Trans>
          </Button>
        </div>
      </div>
    );
  }

  if (isServiceUnavailable && dismissed) {
    return null;
  }

  // 2. No agent ID handling is intentionally ignored

  // 3. Check if agent not found (404 error)
  if (error instanceof NotFoundError) {
    return <NotFound />;
  }

  // Check for 404 status in error object
  const is404 = errorAny?.response?.status === 404 || errorAny?.status === 404;

  if (is404) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="w-full max-w-md rounded-lg border bg-background p-8 text-center shadow-md">
          <div className="mb-6">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
              <svg className="h-8 w-8 text-destructive" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <h1 className="mb-2 text-2xl font-bold text-foreground">
              <Trans>SubAgent not found</Trans>
            </h1>
            <p className="text-muted-foreground">
              {errorAny?.response?.data?.message || errorAny?.message || t`The requested agent could not be found.`}
            </p>
          </div>
          <Button onClick={() => (window.location.href = '/')} className="w-full">
            <Home className="mr-2 h-4 w-4" />
            <Trans>Go to Homepage</Trans>
          </Button>
        </div>
      </div>
    );
  }

  // 4. Generic error fallback
  const handleGoHome = () => {
    window.location.href = '/';
  };

  // Helper to get user-friendly error message
  const getErrorMessage = (error: unknown): string => {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === 'string') {
      return error;
    }
    if (errorAny?.message) {
      return errorAny.message;
    }
    return t`Something went wrong while loading this page.`;
  };

  // Helper to format error details for display
  const getErrorDetails = (error: unknown): string => {
    if (error instanceof Error) {
      return error.stack || error.message;
    }
    if (typeof error === 'string') {
      return error;
    }
    try {
      return JSON.stringify(error, null, 2);
    } catch {
      return String(error);
    }
  };

  const errorMessage = getErrorMessage(error);
  const errorDetails = getErrorDetails(error);

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md rounded-lg border bg-background p-8 text-center shadow-md">
        <div className="mb-6">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
            <svg className="h-8 w-8 text-destructive" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h1 className="mb-2 text-2xl font-bold text-foreground">
            <Trans>Error</Trans>
          </h1>
          <p className="text-muted-foreground">{errorMessage}</p>
        </div>

        <Button onClick={handleGoHome} className="flex w-full items-center justify-center">
          <Home className="mr-2 h-4 w-4" />
          <Trans>Go to Homepage</Trans>
        </Button>

        <div className="mb-6 mt-4">
          <button
            onClick={() => setShowDetails(!showDetails)}
            className="mx-auto flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {showDetails ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            <Trans>Details</Trans>
          </button>
        </div>
      </div>
      {showDetails && (
        <div className="absolute left-1/2 top-[calc(50%+12rem)] w-[calc(100vw-2rem)] max-w-7xl -translate-x-1/2 rounded-md border bg-muted p-4 text-left">
          <pre className="mb-4 overflow-auto whitespace-pre-wrap break-words text-xs text-foreground">
            {errorDetails}
          </pre>
        </div>
      )}
    </div>
  );
};

export default ErrorScreen;
