import { FlowData, FlowDataType, FlowElementTypes } from '@sdk';
import { useDataStreamText } from '@sdk/react/hooks';
import { MarkdownView } from '@src/components/markdown-view';
import { cn } from '@src/lib/utils';
import React, { useMemo } from 'react';

interface ChatMessageProps {
  flowData: FlowData;
  isUser: boolean;
  animateIn?: boolean;
  collapsible?: boolean;
  className?: string;
}

const ChatMessage: React.FC<ChatMessageProps> = ({ flowData, isUser, animateIn = false, className }) => {
  // Determine if this message type should stream
  // Must check both elementType AND dataType since useDataStreamText only supports string data
  const chatMessageTypes: string[] = [FlowElementTypes.TEXT, FlowElementTypes.CHAT, FlowElementTypes.USER_MESSAGE];
  const shouldStream =
    flowData && chatMessageTypes.includes(flowData.elementType) && !isUser && flowData.dataType === FlowDataType.String;

  // Use hook for streaming updates - hook handles event subscription internally
  const streamState = useDataStreamText(shouldStream ? flowData : null);

  // Calculate current content based on streaming state
  const currentContent = useMemo(() => {
    if (!flowData) {
      return '';
    }
    if (!shouldStream) {
      // For non-streaming content (user messages), use FlowData content directly
      return flowData.content;
    }

    // For streaming content, use partial content while streaming, then final content
    if (streamState.isStreaming && streamState.partialContent) {
      return streamState.partialContent;
    }

    return flowData.content;
  }, [flowData, shouldStream, streamState.isStreaming, streamState.partialContent]);

  const isStreaming = shouldStream && streamState.isStreaming;

  // Early return if flowData is undefined or content is empty
  if (!flowData || !currentContent.trim()) {
    return null;
  }

  return (
    <div
      className={cn(
        'px-3 py-2 font-mono',
        isUser
          ? 'border-l-2 border-l-cyan-500/50 bg-cyan-50 dark:bg-cyan-950/20'
          : 'border-l-2 border-l-emerald-500/50 bg-emerald-50 dark:bg-zinc-900/50',
        (animateIn || isStreaming) && 'animate-fade-in opacity-0',
        className,
      )}
      data-testid="chat-message"
    >
      {/* Terminal-style label */}
      <div className="mb-1 flex items-center gap-2">
        <span
          className={cn(
            'text-[10px] uppercase tracking-wider',
            isUser ? 'text-cyan-600 dark:text-cyan-400' : 'text-emerald-600 dark:text-emerald-400',
          )}
        >
          {isUser ? '▸ user' : '◂ assistant'}
        </span>
        {isStreaming && (
          <>
            <span className="text-zinc-300 dark:text-zinc-700">│</span>
            <span className="animate-pulse text-[10px] text-amber-600 dark:text-amber-400">streaming...</span>
          </>
        )}
      </div>

      {/* Content */}
      <div className="text-[12px] leading-relaxed text-zinc-700 dark:text-zinc-300">
        {isUser ? (
          <pre className="whitespace-pre-wrap break-words">{currentContent}</pre>
        ) : (
          <div className="prose prose-sm prose-p:my-1 prose-pre:my-1 prose-pre:bg-zinc-100 prose-pre:text-zinc-800 dark:prose-invert dark:prose-pre:bg-zinc-950 dark:prose-pre:text-zinc-300 max-w-none">
            <MarkdownView value={currentContent} compact />
          </div>
        )}
      </div>
    </div>
  );
};

export default ChatMessage;
