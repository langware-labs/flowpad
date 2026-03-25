import { EnvOpType } from '@src/types/envVarTypes';
import {
  Agent,
  dataContext,
  EnvVarType,
  Flow,
  FlowData,
  FlowElementTypes,
  FlowEvents,
  ICompletionOptions,
} from '@sdk';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router';

import ChatInput from '@src/components/chat-input';
import ChatSkeleton from '@src/components/chat-skeleton';
import ErrorSection from '@src/components/ErrorSection';
import ReasoningSection from '@src/components/ReasoningSection';
import ShellSection from '@src/components/ShellSection';
import StatusMessage from '@src/components/StatusMessage';
import ChatMessage from './chat-message/chat-message';
import { ChatPanelBodyHeader } from './chat-panel-body-header';
import { ChatPanelHeader } from './chat-panel-header/chat-panel-header';

import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import ArtifactSection from '@src/components/artifact-section';
import ArtifactsSection from '@src/components/artifacts-section';
import { AutoScrollContainer, AutoScrollContainerHandle } from '@src/components/AutoScrollContainer';
import CheckpointSection from '@src/components/checkpoint-section';
import EnvVarInputSection from '@src/components/EnvVarInputSection';
import { useEnvVarsStore } from '@src/hooks/use-env-vars-store';
import { useChatOptions } from '@src/hooks/useChatOptions';
import { useEntityLabels } from '@src/hooks/useEntityLabels';
import { useSendMessageStore } from '@src/store/use-send-message-store';
import { useProcess, useProcessActions } from '@sdk/react/hooks';
import { useActiveViewer } from '@src/hooks/flow-hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useProcessCheckpoints, useProcessExecution, useProcessStreamingArtifacts } from '@src/hooks/flow-hooks';

// Local UI message types - only for rendering
// Helper function to determine if FlowData should be rendered as a chat message
function shouldRenderFlowData(flowData: FlowData): boolean {
  const messageTypes: string[] = [
    FlowElementTypes.USER_MESSAGE,
    FlowElementTypes.CHAT,
    FlowElementTypes.TEXT,
    FlowElementTypes.REASONING,
    FlowElementTypes.ENV_VAR,
    FlowElementTypes.SHELL,
    FlowElementTypes.SHELL_INPUT,
    FlowElementTypes.SHELL_OUTPUT,
    FlowElementTypes.RESULT,
    FlowElementTypes.CHECKPOINT,
    FlowElementTypes.ERROR,
    FlowElementTypes.TOOL_CALL,
    FlowElementTypes.TOOL_RESULT,
  ];
  return messageTypes.includes(flowData.elementType);
}

export function ChatPanel() {
  const navigate = useNavigate();
  const { flow: contextFlow } = useAgentContext();
  const scrollContainerRef = useRef<AutoScrollContainerHandle>(null);
  const hasSentPendingMessageRef = useRef(false);

  // Get agent and flow from context instead of URL params
  const agentTypeId = dataContext.agentTypeId;
  const flowTypeId = dataContext.flowTypeId;

  // Get agent from dataManager cache if we have an agentTypeId
  const agent = useMemo(() => {
    if (!agentTypeId) return null;
    const contextEnum = dataContext.activeEntityTypeId2ContextEnum(agentTypeId);
    if (!contextEnum) return null;
    return dataContext.getContextEntity(contextEnum) as Agent | null;
  }, [agentTypeId]);

  // Use flow from context (either from dataContext or from AgentContext)
  const flow = contextFlow || dataContext.flow;
  const { data: flowEntity, isLoading: isFlowLoading } = useProcess(flowTypeId, { enabled: !!flowTypeId });

  const options = useChatOptions(flowTypeId);

  // Cache snapshot to avoid infinite loops
  const snapshotRef = useRef<readonly FlowData[]>([]);

  // Subscribe to flow stream changes
  const subscribe = useCallback(
    (callback: () => void) => {
      const flowInstance = flowEntity || flow;
      if (!flowInstance) return () => {};
      const handler = () => callback();
      flowInstance.on(FlowEvents.DATA, handler);
      return () => flowInstance.off(FlowEvents.DATA, handler);
    },
    [flowEntity, flow],
  );

  const getSnapshot = useCallback(() => {
    const flowInstance = flowEntity || flow;
    const currentItems = flowInstance?.stream.items || [];
    if (
      currentItems.length !== snapshotRef.current.length ||
      currentItems.some((item, i) => item !== snapshotRef.current[i])
    ) {
      snapshotRef.current = currentItems;
    }
    return snapshotRef.current;
  }, [flowEntity, flow]);

  const chat = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const isErrorHistory = false; // Error handling via flow events
  const siteConfig = agent?.site_config;

  // Use flow hooks directly instead of useStreamingFetch
  const { cancel } = useProcessActions(flowEntity ?? flow ?? null);
  const { isRunning } = useProcessExecution(flowEntity ?? flow ?? null);
  const streamLoading = isRunning;
  const { sendMessage, setMessage, pendingMessage, clearPendingMessage } = useSendMessageStore();
  const { navigation } = useDockNavigation();

  // Use activeViewer hook to automatically sync agent focus requests with UI tabs
  // Also automatically handles focusing on last artifact when streaming completes
  useActiveViewer(flowEntity ?? flow);

  // Consolidated chat enabled flag - checks for agent, project, and not streaming
  const hasAgent = !!agentTypeId;
  const hasProject = !!dataContext.projectTypeId;
  const chatEnabled = hasAgent && hasProject && !streamLoading;

  // Local state for streaming content type indicator
  const { envVars, addEnvVar, updateEnvVar, deleteEnvVar } = useEnvVarsStore();

  // Labels from flow options
  const { labels, addLabel, removeLabel } = useEntityLabels(flowTypeId);

  // Wrap sendMessage to create flow if needed (only flow, NOT project)
  const handleSendMessage = useCallback(
    async (message: string, options: ICompletionOptions) => {
      // If no flow exists, create one using the project's create-flow method
      if (!flowTypeId && dataContext.project && agentTypeId) {
        console.log('[ChatPanel] No flow in context, creating new flow via project action...');

        // Use the Project.createFlow method
        const newFlowTypeId = await dataContext.project.createFlow(agentTypeId.id);
        console.log('[ChatPanel] Flow created via backend action:', newFlowTypeId.id);

        // Set flow in context
        const contextEnum = dataContext.activeEntityTypeId2ContextEnum(newFlowTypeId);
        if (contextEnum) {
          await dataContext.setContextEntityTypeId(contextEnum, newFlowTypeId);
        }
      }

      // Send the message
      return sendMessage?.(message, options);
    },
    [flowTypeId, sendMessage, agentTypeId],
  );

  // Get flow data from new hooks (standardized architecture)
  // Note: FlowData streaming is already handled by useProcessChat hook via useProcessStream

  const [currentStatus, setCurrentStatus] = useState('');
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [llmHasEnded, setLlmHasEnded] = useState(false);

  // Get streaming artifacts and the callback to filter by timestamp
  const { getStreamingFlowDataAfter } = useProcessStreamingArtifacts(flowEntity ?? flow);

  // Get FlowData results after the last user message
  const currentConversationResults = useMemo(() => {
    if (!chat || chat.length === 0) return [];

    let lastUserMessage: FlowData | null = null;
    for (let i = chat.length - 1; i >= 0; i--) {
      const flowData = chat[i];
      if (flowData.elementType === FlowElementTypes.USER_MESSAGE || flowData.attributes.role === 'user') {
        lastUserMessage = flowData;
        break;
      }
    }

    if (!lastUserMessage) return [];

    // Get the timestamp of the last user message
    const lastUserMessageTimestamp = new Date(lastUserMessage.timestamp).getTime();

    // Use the callback to get FlowData items after the last user message
    return getStreamingFlowDataAfter(lastUserMessageTimestamp);
  }, [chat, getStreamingFlowDataAfter]);

  // Filter FlowData for chat messages and handle env var positioning
  // Moving this before handleEnvVarSaved to avoid temporal dead zone
  const chatFlowData = useMemo(() => {
    const result: FlowData[] = [];
    const pendingEnvVars: FlowData[] = [];

    for (let i = 0; i < chat.length; i++) {
      const flowData = chat[i];

      if (!shouldRenderFlowData(flowData)) continue; // Skip non-message FlowData

      if (flowData.elementType === FlowElementTypes.ENV_VAR) {
        // Check env_op attribute - default to 'pending' if not specified
        const envOp = (flowData.attributes.env_op as EnvOpType) || EnvOpType.PENDING;

        if (envOp === EnvOpType.PENDING) {
          // User input expected - store for rendering
          pendingEnvVars.push(flowData);
        } else {
          // Notification ops: update store silently (no UI rendering)
          const envVarData = {
            name: flowData.attributes.name || '',
            var_type: (flowData.attributes.var_type as EnvVarType) || EnvVarType.API_KEY,
            description: flowData.content,
          };

          if (envOp === EnvOpType.CREATED) {
            addEnvVar(envVarData);
          } else if (envOp === EnvOpType.UPDATED) {
            updateEnvVar(envVarData);
          } else if (envOp === EnvOpType.DELETED) {
            deleteEnvVar(envVarData.name);
          }
          // Don't add to pendingEnvVars or result - no UI needed for notifications
        }
      } else if (flowData.elementType === FlowElementTypes.USER_MESSAGE && pendingEnvVars.length > 0) {
        // Insert all pending env vars before this user message
        result.push(...pendingEnvVars);
        pendingEnvVars.length = 0; // Clear the array
        result.push(flowData);
      } else {
        result.push(flowData);
      }
    }

    // Add any remaining env vars at the end if no user message was found
    if (pendingEnvVars.length > 0) {
      result.push(...pendingEnvVars);
    }

    return result;
  }, [chat, addEnvVar, updateEnvVar, deleteEnvVar]);

  const handleEnvVarSaved = useCallback(
    (envVar: { name: string; description: string }) => {
      // If it is the last env var, add a continue message
      const requiredEnvVarNames = chatFlowData
        .filter((flowData) => flowData.elementType === FlowElementTypes.ENV_VAR)
        .map((flowData) => flowData.attributes.name || flowData.content);
      const requiredEnvVarsFilled = requiredEnvVarNames.every(
        (envVarName) => envVar.name === envVarName || envVars.some((ev) => ev.name === envVarName),
      );
      if (requiredEnvVarsFilled) {
        setMessage?.(
          `I have saved the ${requiredEnvVarNames.join(', ')} ${
            requiredEnvVarNames.length > 1 ? 'variables' : 'variable'
          }, continue with the next step`,
        );
      }
    },
    [envVars, chatFlowData, setMessage],
  );

  useEffect(() => {
    if (!streamLoading) {
      setShowSkeleton(false);
      return;
    }

    // Show skeleton only after user messages, not after assistant messages
    // This ensures skeleton appears as loading indicator for assistant response
    const lastFlowData = chatFlowData.at(-1);
    const isLastFromUser =
      lastFlowData?.elementType === FlowElementTypes.USER_MESSAGE || lastFlowData?.attributes.role === 'user';
    setShowSkeleton(isLastFromUser);
  }, [streamLoading, chatFlowData]);

  // Process FlowData for side effects (status updates)
  // Note: Goal/Todo/Editor/Results data now handled by dedicated hooks
  useEffect(() => {
    let currentStatus = '';

    // Process each FlowData for side effects
    for (const flowData of chat) {
      // Handle different FlowData types directly
      switch (flowData.elementType) {
        case FlowElementTypes.USER_MESSAGE:
          currentStatus = '';
          setLlmHasEnded(false);
          break;

        case FlowElementTypes.STATUS:
          currentStatus = flowData.content;
          break;

        case FlowElementTypes.LLM_END:
          // Clear status and mark LLM as ended when LLM finishes thinking
          currentStatus = '';
          setLlmHasEnded(true);
          break;

        case FlowElementTypes.STATE:
        case 'goal':
          // No-op: currently handled by stream/state hooks
          break;
      }
    }

    setCurrentStatus(currentStatus);
  }, [
    chat,
    // Note: Zustand store setters are stable and don't need to be in dependencies
  ]);

  // History is completely decoupled from editor
  // editorContent is not synced to store
  // Editor works exclusively with FSStore cache + server downloads

  useEffect(() => {
    if (isErrorHistory && agentTypeId) {
      void navigate(`/${agentTypeId.toUrlString()}`);
    }
  }, [isErrorHistory, agentTypeId, navigate]);

  // Handle pending message from landing page
  useEffect(() => {
    // Wait until we have a flow entity, it's finished loading, and it's not currently running
    if (!pendingMessage || !flowEntity || isFlowLoading || streamLoading || hasSentPendingMessageRef.current) return;
    const { message, options } = pendingMessage;

    // Mark as sent BEFORE sending to prevent double-send
    hasSentPendingMessageRef.current = true;

    // Send the pending message
    void sendMessage?.(message, options);

    // Clear it immediately to prevent re-sending
    clearPendingMessage();
  }, [pendingMessage, flowEntity, isFlowLoading, streamLoading, sendMessage, clearPendingMessage]);

  // Reset the sent flag when navigating away or when pendingMessage is cleared
  useEffect(() => {
    if (!pendingMessage) {
      hasSentPendingMessageRef.current = false;
    }
  }, [pendingMessage]);

  const onCancel = useCallback(() => {
    if (!flowTypeId) return;
    void cancel();
  }, [cancel, flowTypeId]);

  // Get checkpoint operations from hook
  const { getCurrentCheckpoint, restoreCheckpoint } = useProcessCheckpoints(flow);
  const [currentCheckpoint, setCurrentCheckpoint] = useState<string | null>(null);

  // Count checkpoint flowData items
  const checkpointCount = useMemo(() => {
    return chatFlowData.filter((flowData) => flowData.elementType === FlowElementTypes.CHECKPOINT).length;
  }, [chatFlowData]);

  // Fetch current checkpoint when flow changes or when checkpoint count changes and is >= 2
  useEffect(() => {
    const fetchCurrentCheckpoint = async () => {
      if (!flow) return;
      if (checkpointCount < 2) return; // Only fetch when there are at least 2 checkpoints

      try {
        const current = await getCurrentCheckpoint();
        setCurrentCheckpoint(current);
      } catch (error) {
        console.error('Failed to fetch current checkpoint:', error);
      }
    };

    void fetchCurrentCheckpoint();
  }, [flow, getCurrentCheckpoint, checkpointCount]);

  const handleRestoreCheckpoint = useCallback(
    async (checkpointHash: string) => {
      if (!flow) {
        console.error('Cannot restore: no flow available');
        return;
      }

      await restoreCheckpoint(checkpointHash);
      console.log(`Checkpoint ${checkpointHash} restored successfully`);

      // Refresh the flow state to reflect the restored checkpoint
      await flow.loadFlowState();

      // Update current checkpoint
      const newCurrent = await getCurrentCheckpoint();
      setCurrentCheckpoint(newCurrent);
    },
    [flow, restoreCheckpoint, getCurrentCheckpoint],
  );

  // addLabel and removeLabel come from useEntityLabels (global store)
  // labels array is the source of truth - no local state needed

  return (
    <div data-testid="chat-panel" className="flex h-full flex-col border-r bg-background">
      <ChatPanelHeader />

      <ChatPanelBodyHeader
        selected={labels}
        available={labels}
        onToggle={(label) => {
          // Toggle means add if not present, remove if present
          if (labels.includes(label)) {
            removeLabel(label);
          } else {
            addLabel(label);
          }
        }}
        onAdd={addLabel}
        onRemove={removeLabel}
      />

      <AutoScrollContainer ref={scrollContainerRef} data-testid="chat-panel-body">
        <div className="flex flex-col gap-4">
          {chatFlowData.map((flowData, i) => {
            const isLastMessage = i === chatFlowData.length - 1;
            const isStreamingLastMessage = isLastMessage && streamLoading;
            const uniqueKey = `${flowData.timestamp}-${flowData.index}-${i}`;

            // Handle reasoning
            if (flowData.elementType === FlowElementTypes.REASONING) {
              return (
                <ReasoningSection
                  key={uniqueKey}
                  flowData={flowData}
                  isStreaming={isStreamingLastMessage}
                  data-testid={`chat-item-reasoning-${flowData.index || i}`}
                />
              );
            }

            // Handle shell, shell-input, and shell-output
            if (
              flowData.elementType === FlowElementTypes.SHELL ||
              flowData.elementType === FlowElementTypes.SHELL_INPUT ||
              flowData.elementType === FlowElementTypes.SHELL_OUTPUT
            ) {
              return (
                <ShellSection
                  key={uniqueKey}
                  flowData={flowData}
                  isStreaming={isStreamingLastMessage}
                  data-testid={`chat-item-shell-${flowData.index || i}`}
                />
              );
            }

            // Handle env var
            if (flowData.elementType === FlowElementTypes.ENV_VAR) {
              return (
                <EnvVarInputSection
                  key={uniqueKey}
                  envVarInput={{
                    name: flowData.attributes.name || '',
                    description: flowData.content,
                    var_type: flowData.attributes.var_type as EnvVarType | undefined,
                  }}
                  timestamp={flowData.timestamp}
                  onEnvVarSaved={handleEnvVarSaved}
                  onEnvVarUpdated={(envVarName) => {
                    if (flowTypeId?.id) {
                      void Flow.noteItemUpdated(envVarName, flowTypeId.id);
                    }
                    // No need to refetch history - flow.stream is reactive
                  }}
                  data-testid={`chat-item-env-var-${flowData.index || i}`}
                />
              );
            }

            // Handle result - only render if data is available (skip during streaming before data is parsed)
            if (flowData.elementType === FlowElementTypes.RESULT && flowData.data) {
              return (
                <ArtifactSection
                  key={uniqueKey}
                  flowData={flowData}
                  data-testid={`chat-item-result-${flowData.index || i}`}
                />
              );
            }

            // Handle checkpoint
            if (flowData.elementType === FlowElementTypes.CHECKPOINT) {
              const checkpointHash = flowData.attributes.checkpoint_hash || flowData.content;
              const isNotCurrent = currentCheckpoint && checkpointHash !== currentCheckpoint;

              return (
                <CheckpointSection
                  key={uniqueKey}
                  checkpoint_hash={checkpointHash}
                  onCheckpointClick={() => {
                    // Use navigation to open diff viewer via URL
                    void navigation.openDiff(checkpointHash);
                  }}
                  onRestore={isNotCurrent ? () => handleRestoreCheckpoint(checkpointHash) : undefined}
                  data-testid={`chat-item-checkpoint-${flowData.index || i}`}
                />
              );
            }

            // Handle tool call marker
            if (flowData.elementType === FlowElementTypes.TOOL_CALL) {
              const toolData = typeof flowData.content === 'string' ? JSON.parse(flowData.content) : flowData.data;
              const toolName = toolData?.tool_name || 'Unknown Tool';
              return (
                <div
                  key={uniqueKey}
                  data-testid={`chat-item-tool-call-${flowData.index || i}`}
                  className="mx-4 rounded-md border border-blue-200 bg-blue-50 p-2 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-200"
                >
                  <span className="font-medium">🔧 Tool Call:</span> {toolName}
                </div>
              );
            }

            // Handle tool result marker
            if (flowData.elementType === FlowElementTypes.TOOL_RESULT) {
              const toolData = typeof flowData.content === 'string' ? JSON.parse(flowData.content) : flowData.data;
              const toolName = toolData?.tool_name || 'Unknown Tool';
              return (
                <div
                  key={uniqueKey}
                  data-testid={`chat-item-tool-result-${flowData.index || i}`}
                  className="mx-4 rounded-md border border-green-200 bg-green-50 p-2 text-sm text-green-800 dark:border-green-800 dark:bg-green-900/30 dark:text-green-200"
                >
                  <span className="font-medium">✅ Tool Result:</span> {toolName}
                </div>
              );
            }

            // Handle error
            if (flowData.elementType === FlowElementTypes.ERROR) {
              return (
                <ErrorSection
                  key={uniqueKey}
                  flowData={flowData}
                  data-testid={`chat-item-error-${flowData.index || i}`}
                />
              );
            }

            // Handle text, chat, flow-chat, user-message, and user-input (default chat messages)
            if (
              flowData.elementType === FlowElementTypes.TEXT ||
              flowData.elementType === FlowElementTypes.CHAT ||
              flowData.elementType === FlowElementTypes.USER_MESSAGE
            ) {
              const isUser =
                flowData.elementType === FlowElementTypes.USER_MESSAGE || flowData.attributes.role === 'user';
              return (
                <ChatMessage
                  key={uniqueKey}
                  flowData={flowData}
                  isUser={isUser}
                  data-testid={`chat-item-${flowData.elementType}-${flowData.index || i}`}
                />
              );
            }

            return null; // Skip unknown FlowData types
          })}
          {showSkeleton && <ChatSkeleton />}
        </div>
      </AutoScrollContainer>

      <div data-testid="chat-panel-status" className="flex min-h-0 items-center justify-between border-t px-2 py-1">
        <StatusMessage
          status={currentStatus || (streamLoading && !llmHasEnded ? 'Thinking...' : 'Ready')}
          isStreaming={streamLoading && !llmHasEnded}
          showConfettiOnce={false}
        />
        {currentConversationResults.length > 0 && (
          <div className="flex-shrink-0">
            <ArtifactsSection results={currentConversationResults} siteConfig={siteConfig} />
          </div>
        )}
      </div>

      <div data-testid="chat-panel-input" className="border-t p-2">
        <ChatInput
          onSendMessage={(message, options) => void handleSendMessage(message, options)}
          onCancel={onCancel}
          disabled={!chatEnabled}
          siteConfig={siteConfig}
          isFollowup={true}
          detectedMode={options?.values?.mode}
          codebaseConnectionEnabled={true}
        />
      </div>
    </div>
  );
}
