import { TabbedTerminal } from '@src/components/terminal';
import { Button } from '@src/components/ui/button';
import { ChevronDown, ChevronUp, Maximize2, Minimize2 } from 'lucide-react';
import { useState } from 'react';

/**
 * Claude Terminal - Interactive terminal with Claude CLI
 * Replaces the chat panel with an actual terminal session running Claude Code
 */
export function ClaudeTerminal() {
  const [isMinimized, setIsMinimized] = useState(true);
  const [isExpanded, setIsExpanded] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string>('');

  const handleToggleMinimize = () => {
    if (isExpanded) {
      setIsExpanded(false);
    }
    setIsMinimized(!isMinimized);
  };

  const handleToggleExpand = () => {
    if (isMinimized) {
      setIsMinimized(false);
    }
    setIsExpanded(!isExpanded);
  };

  return (
    <div
      className="claude-terminal flex flex-col border-t bg-background transition-all duration-300"
      style={{
        height: isMinimized ? '40px' : isExpanded ? '70vh' : '30vh',
      }}
    >
      <div className="flex h-10 items-center justify-between border-b bg-muted/30 px-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Claude Terminal</span>
        </div>
        <div className="flex items-center gap-1">
          {!isMinimized && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleToggleExpand}
              aria-label={isExpanded ? 'Minimize' : 'Expand'}
            >
              {isExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleToggleMinimize}
            aria-label={isMinimized ? 'Show' : 'Hide'}
          >
            {isMinimized ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </Button>
        </div>
      </div>
      {!isMinimized && (
        <div className="min-h-0 flex-1 overflow-hidden">
          <TabbedTerminal
            className="h-full"
            activeSessionId={activeSessionId}
            onActiveSessionChange={setActiveSessionId}
          />
        </div>
      )}
    </div>
  );
}
