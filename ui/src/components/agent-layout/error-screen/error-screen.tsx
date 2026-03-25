import { NotFoundError } from '@src/errors/NotFoundError';
import NotFound from '@src/pages/NotFound';
import { Button } from '@src/components/ui/button';
import { ChevronDown, ChevronUp, Home } from 'lucide-react';
import { useState } from 'react';
import { useRouteError } from 'react-router';

const ErrorScreen = () => {
  const error = useRouteError();
  const [showDetails, setShowDetails] = useState(false);

  // ERROR HIERARCHY (check in this exact order):

  // 1. Check if service is unavailable (backend not responding)
  const errorAny = error as any;
  const isServiceUnavailable =
    errorAny?.isServiceUnavailable ||
    errorAny?.status === 503 ||
    errorAny?.code === 'ERR_NETWORK' ||
    errorAny?.code === 'ERR_CONNECTION_REFUSED' ||
    errorAny?.message?.includes('Failed to fetch') ||
    errorAny?.message?.includes('Network request failed');

  if (isServiceUnavailable) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="w-full max-w-md rounded-lg border bg-background p-8 text-center shadow-md">
          <div className="mb-6">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
              <svg className="h-8 w-8 text-destructive" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <h1 className="mb-2 text-2xl font-bold text-foreground">Service Unavailable</h1>
            <p className="text-muted-foreground">Backend server is not responding. Please try again later.</p>
          </div>
          <Button onClick={() => window.location.reload()} className="w-full">
            Retry
          </Button>
        </div>
      </div>
    );
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
            <h1 className="mb-2 text-2xl font-bold text-foreground">Agent not found</h1>
            <p className="text-muted-foreground">
              {errorAny?.response?.data?.message || errorAny?.message || 'The requested agent could not be found.'}
            </p>
          </div>
          <Button onClick={() => (window.location.href = '/')} className="w-full">
            <Home className="mr-2 h-4 w-4" />
            Go to Homepage
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
    return 'Something went wrong while loading this page.';
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
          <h1 className="mb-2 text-2xl font-bold text-foreground">Error</h1>
          <p className="text-muted-foreground">{errorMessage}</p>
        </div>

        <Button onClick={handleGoHome} className="flex w-full items-center justify-center">
          <Home className="mr-2 h-4 w-4" />
          Go to Homepage
        </Button>

        <div className="mb-6 mt-4">
          <button
            onClick={() => setShowDetails(!showDetails)}
            className="mx-auto flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {showDetails ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            Details
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
