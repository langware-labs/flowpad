import { Flow, FlowElementTypes } from '@sdk';
import { useProcessStream } from '@src/hooks/flow-hooks';
import React from 'react';

interface ChatStubMessagesProps {
  flow: Flow | null;
}

/**
 * Renders FlowData elements directly - pure FlowData rendering
 * Uses flow.stream.items to get the message data
 */
export const ChatStubMessages: React.FC<ChatStubMessagesProps> = ({ flow }) => {
  // Use the useProcessStream hook to get streaming data
  const { data, isStreaming, streamError } = useProcessStream(flow);

  // Use flow.stream.items directly for the complete list
  const messageData = flow?.stream.items || data;

  return (
    <div data-testid="chat-messages" className="flex-1 overflow-y-auto p-4 space-y-4">
      {messageData.map((flowData, index) => {
        const isUserMessage = flowData.elementType === FlowElementTypes.USER_MESSAGE;

        return (
          <div
            key={flowData.timestamp || flowData.clientId || index}
            data-testid={`message-${index}`}
            data-flow-tag={flowData.elementType}
            data-message-type={flowData.elementType}
            data-client-id={flowData.clientId}
            data-role={isUserMessage ? 'user' : 'assistant'}
            className={`p-3 rounded-lg ${
              isUserMessage ? 'bg-blue-100 ml-auto max-w-[80%]' : 'bg-gray-100 mr-auto max-w-[80%]'
            }`}
          >
            {/* User Messages */}
            {flowData.elementType === FlowElementTypes.USER_MESSAGE && (
              <div data-testid={`message-user-${index}`} className="whitespace-pre-wrap">
                {flowData.content}
              </div>
            )}

            {/* Chat/Assistant Messages */}
            {flowData.elementType === FlowElementTypes.CHAT && (
              <div data-testid={`message-chat-${index}`} className="whitespace-pre-wrap">
                {flowData.content}
              </div>
            )}

            {/* Text Messages */}
            {flowData.elementType === FlowElementTypes.TEXT && (
              <div data-testid={`message-text-${index}`} className="whitespace-pre-wrap">
                {flowData.content}
              </div>
            )}

            {/* Reasoning Messages */}
            {flowData.elementType === FlowElementTypes.REASONING && (
              <div data-testid={`message-reasoning-${index}`} className="italic text-gray-600">
                <span className="font-semibold">Thinking: </span>
                {flowData.content}
              </div>
            )}

            {/* Shell Commands */}
            {flowData.elementType === FlowElementTypes.SHELL && (
              <div data-testid={`message-shell-${index}`} className="font-mono bg-black text-green-400 p-2 rounded">
                $ {flowData.content}
              </div>
            )}

            {/* Results */}
            {flowData.elementType === FlowElementTypes.RESULT && (
              <div data-testid={`message-result-${index}`} className="border-l-4 border-green-500 pl-3">
                <span className="font-semibold">Result: </span>
                <span className="text-sm">{flowData.content}</span>
              </div>
            )}

            {/* Errors */}
            {flowData.elementType === FlowElementTypes.ERROR && (
              <div data-testid={`message-error-${index}`} className="bg-red-50 border-l-4 border-red-500 pl-3 py-2">
                <span className="font-semibold text-red-700">Error: </span>
                <span className="text-red-600">{flowData.data}</span>
              </div>
            )}

            {/* Timestamp */}
            <div className="text-xs text-gray-400 mt-1">
              {flowData.timestamp ? new Date(flowData.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString()}
            </div>
          </div>
        );
      })}

      {/* Streaming Indicator */}
      {isStreaming && (
        <div data-testid="streaming-indicator" className="flex items-center space-x-2 text-gray-500">
          <div className="animate-pulse">●</div>
          <span>AI is thinking...</span>
        </div>
      )}

      {/* Error Display */}
      {streamError && (
        <div data-testid="stream-error" className="bg-red-50 border border-red-200 p-3 rounded">
          <span className="font-semibold text-red-700">Stream Error: </span>
          <span className="text-red-600">{streamError.message}</span>
        </div>
      )}

      {/* Empty State */}
      {messageData.length === 0 && !isStreaming && (
        <div data-testid="empty-messages" className="text-center text-gray-400 py-8">
          No messages yet. Start a conversation!
        </div>
      )}
    </div>
  );
};
