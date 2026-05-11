import React, { useState } from 'react';
import { AgenticProcess } from '@sdk';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { AskForAssistanceDialog } from './AskForAssistanceDialog';

// Bootstrap person-raised-hand icon (same as SendToExpertButton)
const PersonRaisedHandIcon: React.FC<{ className?: string; size?: number }> = ({ className, size = 14 }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="currentColor"
    className={className}
    viewBox="0 0 16 16"
    width={size}
    height={size}
  >
    <path d="M6 6.207v9.043a.75.75 0 0 0 1.5 0V10.5a.5.5 0 0 1 1 0v4.75a.75.75 0 0 0 1.5 0v-8.5a.25.25 0 1 1 .5 0v2.5a.75.75 0 0 0 1.5 0V6.5a3 3 0 0 0-3-3H6.236a1 1 0 0 1-.447-.106l-.33-.165A.83.83 0 0 1 5 2.488V.75a.75.75 0 0 0-1.5 0v2.083c0 .715.404 1.37 1.044 1.689L5.5 5c.32.32.5.754.5 1.207" />
    <path d="M8 3a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3" />
  </svg>
);

function getProcessDisplayName(process: AgenticProcess, fallback: string): string {
  if (process.context_data && typeof process.context_data === 'object') {
    const displayName = (process.context_data as Record<string, unknown>).display_name;
    if (typeof displayName === 'string' && displayName.trim().length > 0) {
      return displayName.trim();
    }
  }

  const processName = (process as { name?: string | null }).name;
  if (typeof processName === 'string' && processName.trim().length > 0) {
    return processName.trim();
  }

  if (process.instruction_content) {
    const trimmed = process.instruction_content.replace(/<!--.*?-->/g, '').trim();
    if (trimmed.length > 0) return trimmed.substring(0, 30);
  }

  return fallback;
}

interface AskForAssistanceButtonProps {
  process: AgenticProcess;
}

export function AskForAssistanceButton({ process }: AskForAssistanceButtonProps) {
  const [dialogOpen, setDialogOpen] = useState(false);

  const sessionTitle = getProcessDisplayName(process, 'Session');

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent"
            onClick={() => setDialogOpen(true)}
            aria-label="Ask for Assistance"
          >
            <PersonRaisedHandIcon size={14} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">Ask for Assistance</TooltipContent>
      </Tooltip>

      <AskForAssistanceDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        sessionTitle={sessionTitle}
        processId={process.id}
        projectPath={(process as any).workdir as string | undefined}
      />
    </>
  );
}
