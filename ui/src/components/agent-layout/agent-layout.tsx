// AgentLayout.tsx
import { AgentContext, useAgentContext } from '@src/contexts/agent-context';
import { ClaudeLoginTerminalHandler } from '@src/components/claude-login-terminal-handler';
import { useAuth } from '@sdk/react/hooks';
import { useState } from 'react';
import { Outlet } from 'react-router';
import LoadingScreen from './loading-screen/loading-screen';
import ServiceUnavailableScreen from './service-unavailable-screen/service-unavailable-screen';

const AgentLayout = () => {
  const { isBootstrapping, someone, error: bootstrapError } = useAuth();

  const contextValues = useAgentContext();

  // Check for bootstrap errors (backend unavailable)
  const bootstrapStatus =
    (bootstrapError as any)?.response?.status || (bootstrapError as any)?.statusCode || (bootstrapError ? 'xxx' : null);
  const isServiceUnavailable =
    bootstrapStatus &&
    (bootstrapStatus === 'xxx' || (typeof bootstrapStatus === 'number' && bootstrapStatus >= 500));

  const [errorDismissed, setErrorDismissed] = useState(false);

  if (!someone || isBootstrapping) {
    return (
      <>
        <LoadingScreen />
        {isServiceUnavailable && !errorDismissed && (
          <ServiceUnavailableScreen statusCode={bootstrapStatus} onClose={() => setErrorDismissed(true)} />
        )}
      </>
    );
  }

  return (
    <div data-testid="agent-layout" className="flex h-screen w-full flex-col overflow-hidden">
      <ClaudeLoginTerminalHandler />
      <Outlet
        context={
          { agent: undefined, flow: undefined, computeNode: contextValues.computeNode, project: contextValues.project } satisfies AgentContext
        }
      />
      {isServiceUnavailable && !errorDismissed && (
        <ServiceUnavailableScreen statusCode={bootstrapStatus} onClose={() => setErrorDismissed(true)} />
      )}
    </div>
  );
};

// Re-export useAgentContext for backward compatibility
export { useAgentContext };

export default AgentLayout;
