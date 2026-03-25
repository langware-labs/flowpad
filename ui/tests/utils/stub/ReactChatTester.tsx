import {
  ContextEntitiesEnum,
  Flow,
  FlowEvents,
  FlowMode,
  FlowStateProperty,
  TypeId,
  UserAction,
  dataContext,
  isEntity,
} from '@sdk';
import { useCurrentArtifacts, useProcess, useProcessActions, useProcessExecution, useProcessStateField, useProcessStream } from '@src/hooks/flow-hooks';
import React, { useCallback, useEffect, useState } from 'react';
import { ChatStubMessages } from './ChatStubMessages';
import { FlowDebugListener } from './FlowDebugListener';
import { FlowStateDebug } from './FlowStateDebug';
import { ArtifactResult } from './StubArtifactResult';
import { ChatInput } from './StubChatInput';
import { TodosPanel } from './TodosPanel';

export interface ReactChatTesterProps {
  processId?: string;
  flow?: Flow;
  onFlowReady?: (flow: Flow) => void;
  onMessageSent?: (message: string) => void;
  onStreamStart?: () => void;
  onStreamEnd?: () => void;
  onResultReceived?: (result: any) => void;
  debugMode?: boolean;
}

/**
 * Minimal chat component that exercises all flow hooks for testing
 * Designed to be test-friendly with data-testid attributes
 */
export const ReactChatTester: React.FC<ReactChatTesterProps> = ({
  processId,
  flow: flowProp,
  onFlowReady,
  onMessageSent,
  onStreamStart,
  onStreamEnd,
  onResultReceived,
  debugMode = false,
}) => {
  const [inputValue, setInputValue] = useState('');

  // Use useProcess for both provided flows and flow IDs
  // useProcess handles history loading automatically in both cases
  // Extract typeId if flowProp is a Flow entity, otherwise use it as TypeId or create from processId
  const flowTypeId: TypeId | null = flowProp
    ? isEntity(flowProp)
      ? flowProp.typeId
      : flowProp instanceof TypeId
        ? flowProp
        : null
    : processId
      ? new TypeId(Flow.type, processId)
      : null;

  // Set flow in dataContext so useProcess (which depends on context) will load it
  useEffect(() => {
    if (flowTypeId) {
      void dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentFlowTypeId, flowTypeId);
    }
  }, [flowTypeId]);

  const { data: flow, isLoading: flowLoading, error: flowError } = useProcess(flowTypeId);

  // All flow hooks
  const { state: _todos } = useProcessStateField(flowTypeId, FlowStateProperty.ROOT_TODO);
  const { data, isStreaming, streamError: _streamError, dataArr } = useProcessStream(flow ?? null);
  const { send, cancel, resume, save, isReady } = useProcessActions(flow ?? null);
  // NOTE: useProcessStateField(flow) without stateKey creates infinite loops (calls stateJson which creates new objects)
  // const { state: _flowState, lastUpdated: _lastUpdated } = useProcessStateField(flow);
  const { executionState, isRunning, isReady: isExecutionReady, isCanceled, isError } = useProcessExecution(flow ?? null);
  const { data: artifacts } = useCurrentArtifacts();
  const hasArtifact = artifacts.length > 0;
  const artifactCount = artifacts.length;

  // User action counters
  const [userActionCounts, setUserActionCounts] = useState({
    [UserAction.Run]: 0,
    [UserAction.Cancel]: 0,
    [UserAction.Resume]: 0,
  });

  // Listen to user action events
  useEffect(() => {
    if (!flow) return;

    const unsubscribeRun = flow.on(FlowEvents.USER_RUN, () => {
      setUserActionCounts((prev) => ({ ...prev, [UserAction.Run]: prev[UserAction.Run] + 1 }));
    });

    const unsubscribeCancel = flow.on(FlowEvents.USER_CANCEL, () => {
      setUserActionCounts((prev) => ({ ...prev, [UserAction.Cancel]: prev[UserAction.Cancel] + 1 }));
    });

    const unsubscribeResume = flow.on(FlowEvents.USER_RESUME, () => {
      setUserActionCounts((prev) => ({ ...prev, [UserAction.Resume]: prev[UserAction.Resume] + 1 }));
    });

    return () => {
      unsubscribeRun();
      unsubscribeCancel();
      unsubscribeResume();
    };
  }, [flow]);

  // Notify when flow is ready
  useEffect(() => {
    if (flow && onFlowReady) {
      onFlowReady(flow);
    }
  }, [flow, onFlowReady]);

  // Handle streaming state changes
  useEffect(() => {
    if (isStreaming && onStreamStart) {
      onStreamStart();
    } else if (!isStreaming && data.length > 0 && onStreamEnd) {
      onStreamEnd();
    }
  }, [isStreaming, data.length, onStreamStart, onStreamEnd]);

  // Handle artifacts/results
  useEffect(() => {
    if (hasArtifact && onResultReceived && artifacts.length > 0) {
      onResultReceived(artifacts[artifacts.length - 1]);
    }
  }, [hasArtifact, artifacts, onResultReceived]);

  const handleSendMessage = useCallback(async () => {
    if (!inputValue.trim() || !isReady || isStreaming) return;

    const message = inputValue.trim();
    setInputValue('');

    if (onMessageSent) {
      onMessageSent(message);
    }

    try {
      await send(message, {
        processId: flow?.id,
        flowMode: FlowMode.AGENT,
        enableSearch: true,
        agentId: flow?.agent_id,
      });
    } catch (error) {
      console.error('Error sending message:', error);
    }
  }, [inputValue, isReady, isStreaming, send, flow, onMessageSent]);

  const handleCancel = useCallback(() => {
    if (isStreaming) {
      void cancel();
    }
  }, [isStreaming, cancel]);

  const handleResume = useCallback(() => {
    void resume();
  }, [resume]);

  const handleSave = useCallback(() => {
    void save();
  }, [save]);

  if (flowLoading) {
    return (
      <div data-testid="chat-tester-loading" className="p-4">
        Loading flow...
      </div>
    );
  }

  if (flowError) {
    return (
      <div data-testid="chat-tester-error" className="p-4 text-red-500">
        Error loading flow: {flowError.message}
      </div>
    );
  }

  if (!flow) {
    return (
      <div data-testid="chat-tester-no-flow" className="p-4">
        No flow available
      </div>
    );
  }

  return (
    <div data-testid="react-chat-tester" className="flex flex-col h-full">
      {/* Main Chat Area */}
      <div className="flex-1 flex gap-4 p-4">
        {/* Messages Panel */}
        <div className="flex-1 flex flex-col">
          <ChatStubMessages flow={flow} />

          {/* Artifact Result Display */}
          {hasArtifact && <ArtifactResult flow={flow} />}

          {/* Input Area */}
          <ChatInput
            value={inputValue}
            onChange={setInputValue}
            onSend={handleSendMessage}
            onCancel={handleCancel}
            isStreaming={isStreaming}
            isReady={isReady}
          />
        </div>

        {/* Side Panel with Todos */}
        <div className="w-80">
          <TodosPanel flow={flow} />
        </div>
      </div>

      {/* Action Buttons */}
      <div data-testid="flow-actions" className="flex gap-2 p-4 border-t">
        <button
          data-testid="cancel-button"
          onClick={handleCancel}
          disabled={!isStreaming}
          className="px-3 py-1 bg-red-500 text-white rounded disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          data-testid="resume-button"
          onClick={handleResume}
          disabled={isStreaming}
          className="px-3 py-1 bg-green-500 text-white rounded disabled:opacity-50"
        >
          Resume
        </button>
        <button
          data-testid="save-button"
          onClick={handleSave}
          disabled={isStreaming}
          className="px-3 py-1 bg-blue-500 text-white rounded disabled:opacity-50"
        >
          Save
        </button>
      </div>

      {/* Debug Panel */}
      {debugMode && (
        <div className="border-t bg-gray-50 p-4 space-y-4">
          <FlowStateDebug flow={flow} />
          <FlowDebugListener flow={flow} maxEvents={20} showRawData={false} />
        </div>
      )}

      {/* Hidden elements for testing state */}
      <div style={{ display: 'none' }}>
        <span data-testid="streaming-state">{isStreaming ? 'true' : 'false'}</span>
        <span data-testid="message-count">{data.length}</span>
        <span data-testid="data-array-count">{dataArr?.length || 0}</span>
        <span data-testid="execution-state">{executionState}</span>
        <span data-testid="is-running">{isRunning ? 'true' : 'false'}</span>
        <span data-testid="is-ready">{isExecutionReady ? 'true' : 'false'}</span>
        <span data-testid="is-canceled">{isCanceled ? 'true' : 'false'}</span>
        <span data-testid="is-error">{isError ? 'true' : 'false'}</span>
        <span data-testid="user-action-run-count">{userActionCounts[UserAction.Run]}</span>
        <span data-testid="user-action-cancel-count">{userActionCounts[UserAction.Cancel]}</span>
        <span data-testid="user-action-resume-count">{userActionCounts[UserAction.Resume]}</span>
        <span data-testid="flow-id">{flow.id}</span>
        <span data-testid="artifact-count">{artifactCount}</span>
        <span data-testid="has-artifact">{hasArtifact ? 'true' : 'false'}</span>
      </div>
    </div>
  );
};
