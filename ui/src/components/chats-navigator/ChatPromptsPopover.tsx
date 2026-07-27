import { AgenticProcess } from '@sdk';
import { type ReactNode, useEffect, useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import {
  PromptIndexPanel,
  usePromptsForProcess,
} from '@src/components/terminal/interactive-terminal/side-windows';
import type { WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';

/**
 * Per-row prompt-review popover for the Chats navigator. The message-count chip
 * (passed as `children`) is the trigger; clicking it opens a popover listing the
 * session's user prompts — the same `PromptIndexPanel` the terminal HistoryModal
 * shows in its "Prompts" peek.
 *
 * The body lives in `PromptsBody`, which `PopoverContent` mounts only while the
 * popover is open. So a closed row pays for nothing beyond the `open` boolean —
 * no AgenticProcess resolution and no `usePromptsForProcess` fetch run until the
 * user actually opens that row's popover.
 */
interface ChatPromptsPopoverProps {
  entry: WorkerHistoryEntry;
  children: ReactNode;
}

export function ChatPromptsPopover({ entry, children }: ChatPromptsPopoverProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        className="w-72 p-0"
        onClick={(e) => e.stopPropagation()}
        data-testid="chat-history-row-prompts"
      >
        <PromptsBody entry={entry} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * Resolves the row's `AgenticProcess` (cached `agentic_process_id` first, falling
 * through to the durable `worker_id` heal when the process row was pruned), then
 * renders its prompt list. Only mounted while the popover is open.
 */
function PromptsBody({ entry }: { entry: WorkerHistoryEntry }) {
  const [process, setProcess] = useState<AgenticProcess | null>(null);
  const [resolving, setResolving] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setResolving(true);
    void (async () => {
      let p: AgenticProcess | null = null;
      if (entry.agentic_process_id) {
        try {
          p = (await AgenticProcess.getById(entry.agentic_process_id)) ?? null;
        } catch {
          p = null;
        }
      }
      if (!p && entry.worker_id) {
        try {
          p = await AgenticProcess.getByWorkerId(entry.worker_id);
        } catch (err) {
          console.error('[ChatPromptsPopover] failed to resolve process:', err);
          p = null;
        }
      }
      if (!cancelled) {
        setProcess(p);
        setResolving(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entry.agentic_process_id, entry.worker_id]);

  const { promptEntries, isLoading } = usePromptsForProcess(process);

  return (
    <>
      <div className="flex items-center gap-1.5 border-b px-3 py-2 text-xs font-medium text-muted-foreground">
        <Trans>Prompts</Trans>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px]">{promptEntries.length}</span>
      </div>
      <div className="flex max-h-[60vh] min-h-0 flex-col overflow-hidden">
        {resolving || (isLoading && promptEntries.length === 0) ? (
          <p className="px-3 py-4 text-center text-xs text-muted-foreground"><Trans>Loading prompts…</Trans></p>
        ) : promptEntries.length === 0 ? (
          <p className="px-3 py-4 text-center text-xs text-muted-foreground"><Trans>No prompts found</Trans></p>
        ) : (
          <PromptIndexPanel
            prompts={promptEntries}
            onScrollToLine={() => {}}
            process={process}
            projectId={process?.project_id ?? null}
          />
        )}
      </div>
    </>
  );
}
