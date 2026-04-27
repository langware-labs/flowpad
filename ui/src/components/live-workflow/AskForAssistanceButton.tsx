import React, { useState } from 'react';
import { AgenticProcess, FlowElementTypes } from '@sdk';
import type { FlowData } from '@sdk';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { AskForAssistanceDialog } from './AskForAssistanceDialog';
import { getCachedTabName, getSessionDisplayName } from './sessionTabUtils';

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

function extractSessionText(
  flowData: readonly FlowData[],
  process: AgenticProcess | null | undefined,
): string {
  const parts: string[] = [];

  if (process?.instruction_content) {
    const instruction = process.instruction_content.replace(/<!--.*?-->/gs, '').trim();
    parts.push(`## Instruction\n${instruction}\n\n`);
  }

  parts.push('## Session\n\n');

  for (const fd of flowData) {
    // Use fd.content (getter) — works for both live stream and history-loaded items.
    // fd.data for history items is the raw string, so data?.content would be undefined.
    const content = (fd as any).content as string ?? '';
    const role: string = (fd as any).attributes?.role ?? '';
    const et = fd.elementType;

    // History items use USER_MESSAGE for user turns; live stream may use CHAT+role=user
    const isUser = et === FlowElementTypes.USER_MESSAGE || (et === FlowElementTypes.CHAT && role === 'user');
    const isAssistant = (et === FlowElementTypes.CHAT && role !== 'user') || et === FlowElementTypes.TEXT;

    if (isUser) {
      if (content) parts.push(`**User:** ${content}\n\n`);
    } else if (isAssistant) {
      if (content) parts.push(`**Assistant:** ${content}\n\n`);
    } else if (et === FlowElementTypes.SHELL_INPUT) {
      if (content) parts.push(`\`\`\`bash\n$ ${content}\n\`\`\`\n\n`);
    } else if (et === FlowElementTypes.SHELL || et === FlowElementTypes.SHELL_OUTPUT) {
      const data = (fd as any).data as any;
      const stdout = data?.stdout ?? content ?? '';
      const stderr = data?.stderr ?? '';
      const output = [stdout, stderr].filter(Boolean).join('\n');
      if (output) parts.push(`\`\`\`\n${output}\n\`\`\`\n\n`);
    } else if (et === FlowElementTypes.ERROR) {
      if (content) parts.push(`**Error:** ${content}\n\n`);
    }
    // REASONING, TOOL_CALL, TOOL_RESULT skipped (too verbose)
  }

  return parts.join('');
}

interface AskForAssistanceButtonProps {
  process: AgenticProcess;
}

export function AskForAssistanceButton({ process }: AskForAssistanceButtonProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [sessionTitle, setSessionTitle] = useState('');
  const [sessionContent, setSessionContent] = useState('');
  const [loading, setLoading] = useState(false);

  const handleOpen = async () => {
    setLoading(true);
    try {
      const entity = process as any;
      if (typeof entity?.loadHistory === 'function') {
        await entity.loadHistory({ force: true });
      }
      const items: readonly FlowData[] = (entity?.flowDataStream?.items as readonly FlowData[]) ?? [];
      const tabName = getCachedTabName(process.id ?? '');
      setSessionTitle(tabName ?? getSessionDisplayName(process, 'Session'));
      setSessionContent(extractSessionText(items, process));
      setDialogOpen(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => void handleOpen()}
            disabled={loading}
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
        sessionContent={sessionContent}
      />
    </>
  );
}
