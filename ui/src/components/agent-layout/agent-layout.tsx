// AgentLayout.tsx
import { AgentContext, useAgentContext } from '@src/contexts/agent-context';
import { useSendMessageStore } from '@src/store/use-send-message-store';
import { ClaudeLoginTerminalHandler } from '@src/components/claude-login-terminal-handler';
import {
  dataManager,
  ExpansionRequest,
  Flow,
  FlowMode,
  ICompletionOptions,
  TypeId,
} from '@sdk';
import { useAuth, useProcess } from '@sdk/react/hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useCallback, useEffect, useMemo } from 'react';
import { Outlet, useParams } from 'react-router';
import LoadingScreen from './loading-screen/loading-screen';
import ServiceUnavailableScreen from './service-unavailable-screen/service-unavailable-screen';

const flowQuery = new ExpansionRequest({ expand: ['auth_scopes', 'permissions'] });

const AgentLayout = () => {
  const params = useParams();
  const processId = params.processId;
  const flowTypeId = useMemo(() => (processId ? new TypeId(Flow.type, processId) : null), [processId]);
  const { isBootstrapping, someone, error: bootstrapError } = useAuth();
  const { data: flow } = useProcess(flowTypeId, { query: flowQuery, initialData: undefined });

  const { setSendMessageHandler: setSendMessage } = useSendMessageStore();
  const { navigation } = useDockNavigation();

  const contextValues = useAgentContext();

  const handleSendMessage = useCallback(
    async (messageText: string, options: ICompletionOptions) => {
      if (processId && options.setActiveView !== false) {
        navigation.closeDock();
      }

      const flowTypeId = new TypeId(Flow.type, options.processId);
      let flowInstance = dataManager.getByTypeIdFromCache<Flow>(flowTypeId);
      if (!flowInstance) {
        flowInstance = new Flow({ id: options.processId });
      }

      return flowInstance.sendMessage(messageText, {
        ...options,
        flowMode: options.flowMode || FlowMode.AGENT,
      });
    },
    [processId, navigation],
  );

  useEffect(() => {
    setSendMessage(handleSendMessage);
  }, [handleSendMessage, setSendMessage]);

  // Check for bootstrap errors (backend unavailable)
  const bootstrapStatus =
    (bootstrapError as any)?.response?.status || (bootstrapError as any)?.statusCode || (bootstrapError ? 'xxx' : null);
  if (
    bootstrapStatus &&
    (bootstrapStatus === 'xxx' || (typeof bootstrapStatus === 'number' && bootstrapStatus >= 500))
  ) {
    return <ServiceUnavailableScreen statusCode={bootstrapStatus} />;
  }

  if (!someone || isBootstrapping) {
    return <LoadingScreen />;
  }

  return (
    <div data-testid="agent-layout" className="flex h-screen w-full flex-col overflow-hidden">
      <ClaudeLoginTerminalHandler />
      <Outlet
        context={
          { agent: undefined, flow, computeNode: contextValues.computeNode, project: contextValues.project } satisfies AgentContext
        }
      />
    </div>
  );
};

// Re-export useAgentContext for backward compatibility
export { useAgentContext };

export default AgentLayout;
