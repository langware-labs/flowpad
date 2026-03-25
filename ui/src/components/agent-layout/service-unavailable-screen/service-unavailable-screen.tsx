import { Button } from '@src/components/ui/button';
import { RefreshCw, Home } from 'lucide-react';

interface ServiceUnavailableScreenProps {
  statusCode?: number | string;
}

// Service Unavailable component when backend is not responding
const ServiceUnavailableScreen = ({ statusCode }: ServiceUnavailableScreenProps) => {
  const handleRefresh = () => {
    window.location.reload();
  };

  const handleGoHome = () => {
    window.location.href = '/';
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-md rounded-lg bg-background p-8 text-center shadow-md">
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
          <h1 className="mb-2 text-2xl font-bold text-gray-900">Service Unavailable</h1>
          {statusCode && <p className="mb-2 font-mono text-lg text-orange-600">Error: {statusCode}</p>}
          <p className="mb-2 text-gray-600">The FlowPad backend server is not responding.</p>
          <p className="text-sm text-gray-500">Please make sure the server is running.</p>
        </div>

        <div className="space-y-3">
          <Button onClick={handleRefresh} className="flex w-full items-center justify-center" variant="default">
            <RefreshCw className="mr-2 h-4 w-4" />
            Retry Connection
          </Button>

          <Button onClick={handleGoHome} className="flex w-full items-center justify-center" variant="outline">
            <Home className="mr-2 h-4 w-4" />
            Go to Homepage
          </Button>
        </div>

        <div className="mt-6 rounded-md bg-blue-50 p-4 text-left">
          <p className="text-sm font-medium text-blue-900">Quick Start Guide:</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-blue-800">
            <li>
              Start the backend: <code className="rounded bg-blue-100 px-1 py-0.5">cd flowpad && python run.py</code>
            </li>
            <li>
              Start the frontend: <code className="rounded bg-blue-100 px-1 py-0.5">cd flowpad/ui && npm run dev</code>
            </li>
            <li>
              Or use: <code className="rounded bg-blue-100 px-1 py-0.5">./ops/scripts/run_claude.sh</code>
            </li>
          </ol>
        </div>
      </div>
    </div>
  );
};

export default ServiceUnavailableScreen;
