import { FlowData, FlowElementTypes } from '@sdk';
import { useDataStreamText } from '@sdk/react/hooks';
import { cn } from '@src/lib/utils';
import { ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

interface ReasoningSectionProps {
  flowData: FlowData;
  isStreaming?: boolean;
  className?: string;
}

// Utility function to format word count
const formatWordCount = (count: number): string => {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}K`;
  }
  return count.toString();
};

const ReasoningSection = ({ flowData, isStreaming, className }: ReasoningSectionProps) => {
  const [isExpanded, setIsExpanded] = useState(false); // Start collapsed by default

  // Use hook for streaming updates - hook handles event subscription internally
  const streamState = useDataStreamText(flowData?.elementType === FlowElementTypes.REASONING ? flowData : null);

  // Calculate current content based on streaming state
  const currentContent = useMemo(() => {
    // Use partial content while streaming, then fall back to flowData content
    if (streamState.isStreaming && streamState.partialContent) {
      return streamState.partialContent;
    }
    return flowData?.content || '';
  }, [streamState.isStreaming, streamState.partialContent, flowData?.content]);

  // Calculate word count
  const wordCount = useMemo(() => {
    if (!currentContent) return 0;
    const count = currentContent
      .trim()
      .split(/\s+/)
      .filter((word) => word.length > 0).length;
    return count;
  }, [currentContent]);

  // Use stream state for isStreaming if not provided as prop
  const activelyStreaming = isStreaming ?? streamState.isStreaming;

  // Track previous streaming state to detect when streaming ends
  const wasStreamingRef = useRef(activelyStreaming);

  // Auto-expand when streaming starts, auto-collapse when streaming ends
  useEffect(() => {
    if (!wasStreamingRef.current && activelyStreaming) {
      // Streaming just started - auto-expand
      setIsExpanded(true);
    } else if (wasStreamingRef.current && !activelyStreaming) {
      // Streaming just ended - auto-collapse
      setIsExpanded(false);
    }
    wasStreamingRef.current = activelyStreaming;
  }, [activelyStreaming]);

  if (!currentContent && !activelyStreaming) {
    return null;
  }

  return (
    <div className={cn('border-l-2 border-l-violet-500/50 bg-violet-50 font-mono dark:bg-zinc-900/50', className)}>
      {/* Terminal-style header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-violet-100 dark:hover:bg-zinc-800/50"
      >
        <ChevronRight
          className={cn('h-3 w-3 text-zinc-400 transition-transform dark:text-zinc-500', isExpanded && 'rotate-90')}
        />
        <span className="text-[10px] uppercase tracking-wider text-violet-600 dark:text-violet-400">thinking</span>
        <span className="text-violet-300 dark:text-zinc-700">│</span>
        {activelyStreaming ? (
          <span className="animate-pulse text-[10px] text-amber-600 dark:text-amber-400">...</span>
        ) : (
          <span className="text-[10px] text-zinc-500">{formatWordCount(wordCount)}</span>
        )}
      </button>

      {/* Content */}
      {isExpanded && (
        <div className="border-t border-violet-200 px-3 py-2 text-[12px] leading-relaxed text-zinc-700 dark:border-zinc-800 dark:text-zinc-400">
          <pre className="whitespace-pre-wrap break-words">{currentContent || (activelyStreaming ? '...' : '')}</pre>
        </div>
      )}
    </div>
  );
};

export default ReasoningSection;
