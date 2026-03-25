import React, { KeyboardEvent } from 'react';

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onCancel: () => void;
  isStreaming: boolean;
  isReady: boolean;
}

/**
 * Chat input component with send controls
 */
export const ChatInput: React.FC<ChatInputProps> = ({ value, onChange, onSend, onCancel, isStreaming, isReady }) => {
  const handleKeyPress = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (canSend) {
        onSend();
      }
    }
  };

  const canSend = value.trim().length > 0 && isReady && !isStreaming;
  const canCancel = isStreaming;

  return (
    <div data-testid="chat-input-container" className="border-t pt-4">
      <div className="flex gap-2">
        <textarea
          data-testid="chat-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyPress={handleKeyPress}
          placeholder={isStreaming ? 'AI is responding...' : !isReady ? 'Flow not ready...' : 'Type your message...'}
          disabled={!isReady}
          className="flex-1 p-3 border rounded-lg resize-none min-h-[60px] disabled:opacity-50 disabled:cursor-not-allowed"
          rows={2}
        />

        <div className="flex flex-col gap-2">
          {canSend && (
            <button
              data-testid="send-button"
              onClick={onSend}
              className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50"
            >
              Send
            </button>
          )}

          {canCancel && (
            <button
              data-testid="cancel-stream-button"
              onClick={onCancel}
              className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600"
            >
              Stop
            </button>
          )}
        </div>
      </div>

      {/* Status indicators */}
      <div className="mt-2 text-xs text-gray-500">
        <span data-testid="input-status">
          {!isReady ? 'Flow not ready' : isStreaming ? 'AI is responding...' : 'Ready to send'}
        </span>
        {value.length > 0 && (
          <span data-testid="char-count" className="ml-2">
            {value.length} characters
          </span>
        )}
      </div>
    </div>
  );
};
