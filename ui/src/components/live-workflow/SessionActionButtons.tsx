import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { Terminal } from 'lucide-react';
import { useResumeInTerminal } from '@src/hooks/use-resume-in-terminal';

interface SessionActionButtonsProps {
  workerSessionId: string | null;
  sessionCwd?: string;
}

/**
 * Resume-in-terminal button for a Claude CLI session.
 * Reusable across SessionViewer, SessionTabBar, or any header that
 * shows actions for a live session.
 */
export function SessionActionButtons({ workerSessionId, sessionCwd }: SessionActionButtonsProps) {
  const { resumeInTerminal } = useResumeInTerminal();

  if (!workerSessionId) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => resumeInTerminal(workerSessionId, sessionCwd)}
        >
          <Terminal className="h-3.5 w-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Resume in terminal</TooltipContent>
    </Tooltip>
  );
}
