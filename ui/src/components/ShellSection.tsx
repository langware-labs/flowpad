import { FlowData } from '@sdk';
import { cn } from '@src/lib/utils';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ChevronRight } from 'lucide-react';
import { useCallback, useState } from 'react';

interface ShellSectionProps {
  flowData: FlowData;
  isStreaming?: boolean;
  collapsible?: boolean;
  className?: string;
}

// Function to strip ANSI escape sequences from text
const stripAnsiCodes = (text: string): string => {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '');
};

const ShellSection = ({ flowData, isStreaming, collapsible, className }: ShellSectionProps) => {
  const { navigation } = useDockNavigation();
  const handleShellClick = useCallback(() => navigation.openShellView(), [navigation]);
  const [isExpanded, setIsExpanded] = useState(true);

  const content: string = flowData.data?.command || flowData.data?.stdout || flowData.content;
  if (!content && !isStreaming) {
    return null;
  }

  // Get the first line of the shell content and remove terminal prefix
  const contentLines = content ? content.split('\n') : [''];
  const firstLine = contentLines[0];

  // Strip ANSI escape sequences first
  const cleanedLine = stripAnsiCodes(firstLine);

  // Remove common terminal prefixes like "ubuntu@flowpad:~ $", "user@host:path $", etc.
  const cleanLine = cleanedLine.replace(/^[^@]*@[^:]*:[^$]*\$\s*/, '').trim();

  const maxLength = 80;
  const truncated = cleanLine.length > maxLength;
  const subtext = truncated ? cleanLine.substring(0, maxLength) + '...' : cleanLine;
  const shouldCollapse = collapsible ?? (contentLines.length > 1 || truncated);

  return (
    <div
      className={cn(
        'cursor-pointer border-l-2 border-l-orange-500/50 bg-orange-50 font-mono dark:bg-zinc-900/50',
        className,
      )}
      onClick={handleShellClick}
    >
      {/* Terminal-style header */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          setIsExpanded(!isExpanded);
        }}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-orange-100 dark:hover:bg-zinc-800/50"
      >
        {shouldCollapse && (
          <ChevronRight
            className={cn('h-3 w-3 text-zinc-400 transition-transform dark:text-zinc-500', isExpanded && 'rotate-90')}
          />
        )}
        <span className="text-[10px] uppercase tracking-wider text-orange-600 dark:text-orange-400">$</span>
        <span className="flex-1 truncate text-[11px] text-zinc-700 dark:text-zinc-300">{subtext || 'shell'}</span>
        {isStreaming && (
          <>
            <span className="text-orange-300 dark:text-zinc-700">│</span>
            <span className="animate-pulse text-[10px] text-amber-600 dark:text-amber-400">exec...</span>
          </>
        )}
      </button>

      {/* Full output */}
      {shouldCollapse && isExpanded && (
        <div className="border-t border-orange-200 px-3 py-2 dark:border-zinc-800">
          <pre className="overflow-x-auto text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-400">{content}</pre>
        </div>
      )}
    </div>
  );
};

export default ShellSection;
