import { FlowData, FlowElementTypes, ProcessorStatus } from '@sdk';
import { cn } from '@src/lib/utils';
import { ArrowDown, Clock, Square, Zap } from 'lucide-react';
import { FusionSpinner } from '@src/components/icons/FusionSpinner';
import { useCallback, useEffect, useRef, useState } from 'react';

import ChatMessage from '@src/pages/flow-page/chat-panel/chat-message/chat-message';
import ErrorSection from '@src/components/ErrorSection';
import ReasoningSection from '@src/components/ReasoningSection';
import ShellSection from '@src/components/ShellSection';

interface RunningAreaProps {
  flowData: readonly FlowData[];
  status: ProcessorStatus;
  isRunning: boolean;
  elapsedTime: string | null;
  statusMessage: string | null;
  activityLabel: string | null;
  tokenUsage: { input: number; output: number } | null;
  onAbort?: () => void;
  className?: string;
}

/**
 * RunningArea - Conversation/FlowData stream with status bar at bottom
 *
 * Displays execution output with newest content at the bottom.
 * Status bar showing running/thinking, time, tokens is at the BOTTOM.
 */
export function RunningArea({
  flowData,
  status,
  isRunning,
  elapsedTime,
  statusMessage,
  activityLabel,
  tokenUsage,
  onAbort,
  className,
}: RunningAreaProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [showScrollButton, setShowScrollButton] = useState(false);

  // Check if user is at the bottom of the scroll container
  const checkScrollPosition = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
    setIsAtBottom(isNearBottom);
    setShowScrollButton(!isNearBottom && flowData.length > 0);
  }, [flowData.length]);

  // Scroll to bottom (latest content)
  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  }, []);

  // Auto-scroll when new content arrives (if user is at bottom)
  useEffect(() => {
    if (isAtBottom) {
      scrollToBottom();
    }
  }, [flowData.length, isAtBottom, scrollToBottom]);

  // Listen for scroll events
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    container.addEventListener('scroll', checkScrollPosition);
    return () => container.removeEventListener('scroll', checkScrollPosition);
  }, [checkScrollPosition]);

  // Format token count for display
  const formatTokens = (count: number): string => {
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
    if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
    return count.toString();
  };

  // Filter function to determine which FlowData should be rendered
  const shouldRenderFlowData = (fd: FlowData): boolean => {
    const messageTypes: string[] = [
      FlowElementTypes.USER_MESSAGE,
      FlowElementTypes.CHAT,
      FlowElementTypes.TEXT,
      FlowElementTypes.REASONING,
      FlowElementTypes.SHELL,
      FlowElementTypes.SHELL_INPUT,
      FlowElementTypes.SHELL_OUTPUT,
      FlowElementTypes.ERROR,
    ];
    return messageTypes.includes(fd.elementType);
  };

  // Filter flowData for renderable items
  const renderableFlowData = flowData.filter(shouldRenderFlowData);

  // Get terminal-style status color
  const getStatusColor = () => {
    if (status === ProcessorStatus.ERROR) return 'text-red-600 dark:text-red-400';
    if (status === ProcessorStatus.COMPLETE) return 'text-emerald-600 dark:text-emerald-400';
    if (isRunning) return 'text-amber-600 dark:text-amber-400';
    return 'text-zinc-500';
  };

  return (
    <div className={cn('relative flex flex-col bg-zinc-50 dark:bg-zinc-950', className)}>
      {/* FlowData Stream - scrollable area with terminal feel */}
      <div ref={scrollContainerRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3 pb-8">
        {/* Empty state - terminal style */}
        {renderableFlowData.length === 0 && (
          <div className="flex flex-1 items-center justify-center py-8 font-mono text-[11px] text-zinc-400 dark:text-zinc-600">
            {isRunning ? '▸ awaiting output...' : '○ no output'}
          </div>
        )}

        {/* FlowData items - using ChatPanel-style component routing */}
        {renderableFlowData.map((fd, index) => {
          const isLastMessage = index === renderableFlowData.length - 1;
          const isStreaming = isLastMessage && isRunning;
          const key = `${fd.timestamp}-${fd.index}-${index}`;

          // Handle reasoning
          if (fd.elementType === FlowElementTypes.REASONING) {
            return (
              <div key={key} className="mb-2">
                <ReasoningSection flowData={fd} isStreaming={isStreaming} />
              </div>
            );
          }

          // Handle shell, shell-input, and shell-output
          if (
            fd.elementType === FlowElementTypes.SHELL ||
            fd.elementType === FlowElementTypes.SHELL_INPUT ||
            fd.elementType === FlowElementTypes.SHELL_OUTPUT
          ) {
            return (
              <div key={key} className="mb-2">
                <ShellSection flowData={fd} isStreaming={isStreaming} />
              </div>
            );
          }

          // Handle error
          if (fd.elementType === FlowElementTypes.ERROR) {
            return (
              <div key={key} className="mb-2">
                <ErrorSection flowData={fd} />
              </div>
            );
          }

          // Handle text, chat, user-message (default chat messages)
          if (
            fd.elementType === FlowElementTypes.TEXT ||
            fd.elementType === FlowElementTypes.CHAT ||
            fd.elementType === FlowElementTypes.USER_MESSAGE
          ) {
            const isUser = fd.elementType === FlowElementTypes.USER_MESSAGE || fd.attributes.role === 'user';
            return (
              <div key={key} className="mb-2">
                <ChatMessage flowData={fd} isUser={isUser} />
              </div>
            );
          }

          return null;
        })}
      </div>

      {/* Scroll to bottom button - terminal style */}
      {showScrollButton && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-10 right-3 flex items-center gap-1.5 border border-zinc-300 bg-white px-2 py-1 font-mono text-[10px] text-zinc-500 shadow-sm transition-colors hover:border-zinc-400 hover:text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:border-zinc-600 dark:hover:text-zinc-300"
        >
          <ArrowDown className="h-3 w-3" />
          <span className="uppercase tracking-wider">latest</span>
        </button>
      )}

      {/* Terminal-style Status Bar at BOTTOM */}
      <div className="absolute bottom-0 left-0 right-0 flex items-center gap-3 border-t border-zinc-200 bg-white px-3 py-1 font-mono text-[11px] dark:border-zinc-800 dark:bg-zinc-950">
        {/* Status indicator */}
        <div className="flex items-center gap-1.5">
          {isRunning ? (
            <FusionSpinner size="xs" />
          ) : (
            <span
              className={cn(
                'inline-block h-1.5 w-1.5 rounded-full',
                status === ProcessorStatus.ERROR
                  ? 'bg-red-500'
                  : status === ProcessorStatus.COMPLETE
                    ? 'bg-emerald-500'
                    : 'bg-zinc-400 dark:bg-zinc-600',
              )}
            />
          )}
          <span className={getStatusColor()}>
            {status === ProcessorStatus.COMPLETE
              ? 'DONE'
              : status === ProcessorStatus.ERROR
                ? 'ERR'
                : isRunning
                  ? activityLabel?.toUpperCase() || 'EXEC'
                  : 'IDLE'}
          </span>
        </div>

        {/* Separator */}
        <span className="text-zinc-300 dark:text-zinc-700">│</span>

        {/* Elapsed time */}
        {elapsedTime && (
          <div className="flex items-center gap-1 text-zinc-500" title="Elapsed time">
            <Clock className="h-3 w-3" />
            <span>{elapsedTime}</span>
          </div>
        )}

        {/* Token usage */}
        {tokenUsage && (
          <>
            <span className="text-zinc-300 dark:text-zinc-700">│</span>
            <div className="flex items-center gap-1 text-zinc-500" title="Token usage">
              <Zap className="h-3 w-3" />
              <span>{formatTokens(tokenUsage.input + tokenUsage.output)}</span>
            </div>
          </>
        )}

        {/* FlowData count */}
        <span className="text-zinc-300 dark:text-zinc-700">│</span>
        <div className="text-zinc-500" title="Output count">
          <span className="text-zinc-400 dark:text-zinc-600">[</span>
          <span>{flowData.length}</span>
          <span className="text-zinc-400 dark:text-zinc-600">]</span>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Status message (if any) */}
        {statusMessage && (
          <div className="max-w-[200px] truncate text-zinc-500" title={statusMessage}>
            {statusMessage}
          </div>
        )}

        {/* Abort button */}
        {isRunning && onAbort && (
          <button
            onClick={onAbort}
            className="flex items-center gap-1 text-zinc-500 transition-colors hover:text-red-500 dark:hover:text-red-400"
            title="Stop execution"
          >
            <span className="text-zinc-300 dark:text-zinc-700">[</span>
            <Square className="h-3 w-3" />
            <span className="text-[10px] uppercase tracking-wider">stop</span>
            <span className="text-zinc-300 dark:text-zinc-700">]</span>
          </button>
        )}
      </div>
    </div>
  );
}
