import { dataContext } from '@sdk';
import { Button } from '@src/components/ui/button';
import { useAuth } from '@sdk/react/hooks';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import ServiceUnavailableScreen from '@src/components/agent-layout/service-unavailable-screen/service-unavailable-screen';

const AgentRedirect = () => {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const { error: bootstrapError } = useAuth();

  useEffect(() => {
    let isMounted = true;
    if (!isMounted) return;

    // Don't set error if service is unavailable - will show ServiceUnavailableScreen
    if ((bootstrapError as any)?.response?.status === 503 || (bootstrapError as any)?.statusCode === 503) {
      return;
    }

    const defaultAgentTypeId = dataContext.agentTypeId;
    if (!defaultAgentTypeId) {
      setError('No default agent found, missing agent type ID in context.');
      return;
    }

    void navigate(`/${defaultAgentTypeId.toUrlString()}`, { replace: true });

    return () => {
      isMounted = false;
    };
  }, [navigate, setError, bootstrapError]);

  // Check for bootstrap errors first (e.g., backend unavailable)
  if ((bootstrapError as any)?.response?.status === 503 || (bootstrapError as any)?.statusCode === 503) {
    return <ServiceUnavailableScreen />;
  }

  if (error) {
    return (
      <div className="flex min-h-screen flex-col">
        <div className="absolute left-4 top-4">
          <a href="https://flowpad.ai">
            <img src="https://flowpad.ai/logo.png" alt="FlowPad" className="h-8" />
          </a>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <h2 className="mb-4 text-2xl font-semibold">Something went wrong</h2>
            <p className="text-gray-600">{error}</p>
            <p className="text-gray-600">
              Please contact support at
              <a
                href={
                  'mailto:support@flowpad.ai?subject=Flowpad App not loading - ' +
                  `${encodeURIComponent(window.location.hostname)}&body=${encodeURIComponent(error)}`
                }
                className="pl-1 underline"
              >
                support@flowpad.ai
              </a>
            </p>
            <Button className="mt-16" variant="outline" onClick={() => window.location.reload()}>
              Retry
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return null;
};

export default AgentRedirect;
