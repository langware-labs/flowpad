import { useEffect, useRef } from 'react';
import { AgenticProcess, Task, TypeId, type ProcessIconKey } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { pickProcessIcon } from '@src/components/icons/process-icons';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { useMyProcess } from './useMyProcess';

interface OpenInClaudeButtonProps {
  task: Task;
  conversationId: string;
  senderName?: string;
  /** Wraps the action so the project picker can resolve a `cwd` first. */
  ensureMapped?: (continuation: () => void | Promise<void>) => void;
  /** Visual variant. `chip` matches the toolbar look; `inline` is the larger
   *  version used in the Context tab. */
  variant?: 'chip' | 'inline';
}

/**
 * "Open in Claude" affordance for a Task. Tooltip flips between
 *   - `Open Claude Code` when `task.my_process_id` is set (resumes the session)
 *   - `Start in Claude` when no session exists yet (spawns + stamps)
 *
 * Lifted out of TaskChips so the conversation Context tab can reuse it without
 * duplicating the `useMyProcess` glue.
 */
export function OpenInClaudeButton({
  task,
  conversationId,
  senderName,
  ensureMapped,
  variant = 'chip',
}: OpenInClaudeButtonProps) {
  const { isStartLabel, busy, openOrStart } = useMyProcess({ task, conversationId, senderName });
  const openOrStartRef = useRef(openOrStart);
  useEffect(() => {
    openOrStartRef.current = openOrStart;
  }, [openOrStart]);

  const { data: process } = useEntity<AgenticProcess>(
    task.my_process_id ? new TypeId(AgenticProcess.type, task.my_process_id) : null,
  );

  const iconKey: ProcessIconKey = process ? process.icon : 'claude';
  const ProcessIcon = pickProcessIcon(iconKey);
  const tooltip = isStartLabel ? 'Start in Claude' : 'Open Claude Code';
  const handleClick = () => {
    const action = () => openOrStartRef.current();
    if (ensureMapped) ensureMapped(action);
    else void action();
  };

  if (variant === 'inline') {
    return (
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        aria-label={tooltip}
        className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-[11px] text-orange-500 transition-colors hover:bg-orange-500/10 disabled:opacity-50"
      >
        {ProcessIcon ? (
          <ProcessIcon className="h-3.5 w-3.5" />
        ) : (
          <ClaudeIcon className="h-3.5 w-3.5" />
        )}
        <span className="text-foreground">{busy ? 'Starting…' : tooltip}</span>
      </button>
    );
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleClick}
            disabled={busy}
            aria-label={tooltip}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-orange-500 transition-colors hover:bg-orange-500/10 disabled:opacity-50"
          >
            {ProcessIcon ? (
              <ProcessIcon className="h-3.5 w-3.5" />
            ) : (
              <ClaudeIcon className="h-3.5 w-3.5" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-[11px]">
          {busy ? 'Starting…' : tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
