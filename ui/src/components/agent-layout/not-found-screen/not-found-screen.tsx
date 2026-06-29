import { Button } from '@src/components/ui/button';
import { Home } from 'lucide-react';
import { Trans } from '@lingui/react/macro';

// Not Found component for private agents
const NotFoundScreen = () => {
  const handleGoHome = () => {
    window.location.href = '/';
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="w-full max-w-md rounded-lg border bg-card p-8 text-center shadow-md">
        <div className="mb-6">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
            <svg className="h-8 w-8 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9.172 16.172a4 4 0 015.656 0M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </svg>
          </div>
          <h1 className="mb-2 text-2xl font-bold text-foreground"><Trans>404 - Not Found</Trans></h1>
          <p className="text-muted-foreground"><Trans>The agent you're looking for doesn't exist or is not available.</Trans></p>
        </div>

        <Button onClick={handleGoHome} className="flex w-full items-center justify-center">
          <Home className="mr-2 h-4 w-4" />
          <Trans>Go to Homepage</Trans>
        </Button>
      </div>
    </div>
  );
};

export default NotFoundScreen;
