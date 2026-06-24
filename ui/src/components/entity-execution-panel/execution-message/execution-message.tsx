import { FlowData, FlowDataType, FlowElementTypes } from '@sdk';
import { useDataStreamText } from '@sdk/react/hooks';
import { DotPulse } from '@src/components/dot-pulse';
import { workerIcon, workerLabel } from '@src/components/lens-viewer/shared/transcript-features/transcript-utils';
import { MarkdownView } from '@src/components/markdown-view';
import { cn } from '@src/lib/utils';
import { User } from 'lucide-react';
import React, { useMemo } from 'react';

interface ExecutionMessageProps {
  flowData: FlowData;
  isUser: boolean;
  animateIn?: boolean;
  collapsible?: boolean;
  className?: string;
  /** Assistant vendor (claude_code/codex/copilot) — picks the worker icon + label. */
  worker?: string;
}

const ExecutionMessage: React.FC<ExecutionMessageProps> = ({ flowData, isUser, animateIn = false, className, worker }) => {
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

  // Stacked, left-aligned turns (ChatGPT / Gemini / Claude-Code style): a leading
  // identity row (icon + name) over the message body — no left/right bubble split.
  const Icon = isUser ? User : workerIcon(worker);
  const name = isUser ? 'You' : workerLabel(worker);

  return (
    <div
      className={cn('py-2.5', animateIn && 'animate-fade-in opacity-0', className)}
      data-testid="execution-message"
      data-role={isUser ? 'user' : 'assistant'}
      aria-live={isStreaming ? 'polite' : undefined}
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon className="h-3 w-3" />
        </span>
        <span className="text-[13px] font-semibold text-foreground">{name}</span>
      </div>
      <div className="min-w-0 break-words pl-7 text-[15px] leading-7 text-foreground">
        <MarkdownView value={currentContent} compact />
        {isStreaming && (
          <span className="mt-1 inline-flex" aria-label="Assistant is responding">
            <DotPulse />
          </span>
        )}
      </div>
    </div>
  );
};

export default ExecutionMessage;
