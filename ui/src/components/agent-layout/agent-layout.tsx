// AgentLayout.tsx
import { AgentContext, useAgentContext } from '@src/contexts/agent-context';
import { ClaudeLoginTerminalHandler } from '@src/components/claude-login-terminal-handler';
import { useAuth } from '@sdk/react/hooks';
import { isBackendUnreachable } from '@sdk';
import { useState } from 'react';
import { Outlet } from 'react-router';
import LoadingScreen from './loading-screen/loading-screen';
import ServiceUnavailableScreen from './service-unavailable-screen/service-unavailable-screen';

const AgentLayout = () => {
  const { isBootstrapping, someone, error: bootstrapError } = useAuth();

  const contextValues = useAgentContext();

  // One predicate, owned by the layer that classifies the error (ts_sdk/client).
  // No status is passed: `isBackendUnreachable` is true only when there was no
  // response, so any code we could show here would be one we invented.
  const isServiceUnavailable = isBackendUnreachable(bootstrapError);

  const [errorDismissed, setErrorDismissed] = useState(false);
  const unavailableOverlay =
    isServiceUnavailable && !errorDismissed ? (
      <ServiceUnavailableScreen onClose={() => setErrorDismissed(true)} />
    ) : null;

  if (!someone || isBootstrapping) {
    return (
      <>
        <LoadingScreen />
        {unavailableOverlay}
      </>
    );
  }

  return (
    <div data-testid="agent-layout" className="flex h-screen w-full flex-col overflow-hidden">
      <ClaudeLoginTerminalHandler />
      <Outlet
        context={
          {
            agent: undefined,
            flow: undefined,
            computeNode: contextValues.computeNode,
            project: contextValues.project,
          } satisfies AgentContext
        }
      />
      {unavailableOverlay}
    </div>
  );
};

// Re-export useAgentContext for backward compatibility
export { useAgentContext };

export default AgentLayout;
