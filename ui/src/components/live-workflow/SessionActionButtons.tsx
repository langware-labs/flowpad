import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { ScanSearch, Terminal } from 'lucide-react';
import { useSessionClassify } from '@src/hooks/use-session-classify';
import { useResumeInTerminal } from '@src/hooks/use-resume-in-terminal';

interface SessionActionButtonsProps {
  workerSessionId: string | null;
  sessionCwd?: string;
}

/**
 * Classify + Resume-in-terminal buttons for a Claude CLI session.
 * Reusable across SessionViewer, SessionTabBar, or any header that
 * shows actions for a live session.
 */
function ResumeButton({ sessionId, sessionCwd }: { sessionId: string; sessionCwd?: string }) {
  const { resumeInTerminal } = useResumeInTerminal();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => resumeInTerminal(sessionId, sessionCwd)}
        >
          <Terminal className="h-3.5 w-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Resume in terminal</TooltipContent>
    </Tooltip>
  );
}

export function SessionActionButtons({ workerSessionId, sessionCwd }: SessionActionButtonsProps) {
  const { classifySession, classifyingSessionIds, classificationExists, isWorkerSession } = useSessionClassify({
    currentSessionId: workerSessionId ?? undefined,
  });

  if (!workerSessionId) return null;

  // Hide classify button on worker sessions (sessions created to run classifications)
  if (isWorkerSession) {
    return <ResumeButton sessionId={workerSessionId} sessionCwd={sessionCwd} />;
  }

  const isClassifying = classifyingSessionIds.has(workerSessionId);

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            disabled={isClassifying || !sessionCwd || classificationExists}
            onClick={() => sessionCwd && void classifySession(workerSessionId, sessionCwd)}
          >
            <ScanSearch className={`h-3.5 w-3.5 ${isClassifying ? 'animate-pulse text-amber-500' : ''}`} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {isClassifying ? 'Classifying...' : classificationExists ? 'Already classified' : 'Classify session'}
        </TooltipContent>
      </Tooltip>
      <ResumeButton sessionId={workerSessionId} sessionCwd={sessionCwd} />
    </>
  );
}
