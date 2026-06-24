import { FlowData, FlowDataType, FlowElementTypes } from '@sdk';
import { useDataStreamText } from '@sdk/react/hooks';
import { DotPulse } from '@src/components/dot-pulse';
import { MarkdownView } from '@src/components/markdown-view';
import { cn } from '@src/lib/utils';
import React, { useMemo } from 'react';

interface ExecutionMessageProps {
  flowData: FlowData;
  isUser: boolean;
  animateIn?: boolean;
  collapsible?: boolean;
  className?: string;
}

const ExecutionMessage: React.FC<ExecutionMessageProps> = ({ flowData, isUser, animateIn = false, className }) => {
  // Determine if this message type should stream
  // Must check both elementType AND dataType since useDataStreamText only supports string data
  const messageTypes: string[] = [FlowElementTypes.TEXT, FlowElementTypes.CHAT, FlowElementTypes.USER_MESSAGE];
  const shouldStream =
    flowData && messageTypes.includes(flowData.elementType) && !isUser && flowData.dataType === FlowDataType.String;

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

  // User → a subtle right-aligned pill. Assistant → full-width prose, no bubble
  // (the message column itself is the surface, claude.ai-style).
  if (isUser) {
    return (
      <div
        className={cn('flex justify-end py-1.5', animateIn && 'animate-fade-in opacity-0', className)}
        data-testid="execution-message"
      >
        <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl bg-muted px-4 py-2 text-[15px] leading-6 text-foreground">
          {currentContent}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn('py-1.5 text-[15px] leading-7 text-foreground', animateIn && 'animate-fade-in opacity-0', className)}
      data-testid="execution-message"
      aria-live={isStreaming ? 'polite' : undefined}
    >
      <MarkdownView value={currentContent} compact />
      {isStreaming && (
        <span className="mt-1 inline-flex" aria-label="Assistant is responding">
          <DotPulse />
        </span>
      )}
    </div>
  );
};

export default ExecutionMessage;
