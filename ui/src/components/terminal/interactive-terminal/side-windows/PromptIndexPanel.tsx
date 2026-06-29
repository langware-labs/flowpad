import { ArrowDown, ArrowUp, Check, Copy, Loader2, MessageSquare, Pin } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { AgenticProcess } from '@sdk';
import { cn } from '@src/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { timeAgo } from '@src/components/entity-execution-panel/history-row';
import {
  normalizePromptText,
  useLibraryPromptsForProject,
} from '@src/components/prompt-library/useLibraryPromptsForProject';

export interface PromptEntry {
  absRow: number | null;
  text: string;
  time: string;
  source: 'annotation' | 'trace' | 'transcript';
}

interface PromptIndexPanelProps {
  prompts: PromptEntry[];
  onScrollToLine: (absRow: number) => void;
  /**
   * When provided (together with `projectId`), each item carries a pin
   * button: pin = save the item's text as a library Prompt mutually
   * cross-linked with this process; unpin = remove it from the library.
   */
  process?: AgenticProcess | null;
  /** Project scope for the library pin-state lookup. */
  projectId?: string | null;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso;
  }
}

const PromptItem: React.FC<{
  entry: PromptEntry;
  onScrollToLine: (absRow: number) => void;
  /** Whether this item's text already exists in the prompt library. */
  isPinned?: boolean;
  /** Pin/unpin toggle — absent hides the pin button entirely. */
  onTogglePin?: () => Promise<void>;
}> = ({ entry, onScrollToLine, isPinned = false, onTogglePin }) => {
  const { t } = useLingui();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);

  const handleClick = () => {
    setExpanded((v) => !v);
    if (entry.absRow !== null) {
      onScrollToLine(entry.absRow);
    }
  };

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(entry.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const handleTogglePin = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onTogglePin || pinBusy) return;
    setPinBusy(true);
    void onTogglePin().finally(() => setPinBusy(false));
  };

  const preview = entry.text.length > 80 ? entry.text.slice(0, 80) + '…' : entry.text;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="group cursor-pointer rounded px-2 py-1.5 hover:bg-muted/50" onClick={handleClick}>
          <div className="flex items-start gap-1.5">
            <span
              className={cn(
                'mt-0.5 shrink-0 text-[9px] font-bold uppercase',
                entry.source === 'annotation' && 'text-lime-400',
                entry.source === 'trace' && 'text-sky-400',
                entry.source === 'transcript' && 'text-amber-400',
              )}
            >
              {entry.source === 'annotation' ? 'A' : entry.source === 'trace' ? 'T' : 'P'}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-1">
                <span className="flex items-baseline gap-1 text-[10px] text-muted-foreground">
                  <span>{formatTime(entry.time)}</span>
                  <span className="text-muted-foreground/60">· {timeAgo(entry.time)}</span>
                </span>
                <div className="flex items-center gap-1">
                  {entry.absRow !== null && (
                    <span className="shrink-0 text-[9px] text-muted-foreground/60">→ {entry.absRow}</span>
                  )}
                  {onTogglePin && (
                    <button
                      className={cn(
                        'shrink-0 rounded p-0.5 transition-opacity hover:bg-muted',
                        isPinned ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                      )}
                      onClick={handleTogglePin}
                      title={isPinned ? t`Unpin — remove from prompt library` : t`Pin to prompt library`}
                      data-testid="prompt-index-pin"
                      aria-pressed={isPinned}
                    >
                      {pinBusy ? (
                        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                      ) : (
                        <Pin
                          className={cn('h-3 w-3', isPinned ? 'fill-current text-lime-400' : 'text-muted-foreground')}
                        />
                      )}
                    </button>
                  )}
                  <button
                    className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100"
                    onClick={handleCopy}
                    title={t`Copy prompt`}
                  >
                    {copied ? (
                      <Check className="h-3 w-3 text-lime-400" />
                    ) : (
                      <Copy className="h-3 w-3 text-muted-foreground" />
                    )}
                  </button>
                </div>
              </div>
              {expanded ? (
                <pre className="mt-1 whitespace-pre-wrap break-words text-xs text-foreground">{entry.text}</pre>
              ) : (
                <p className="mt-0.5 text-xs text-foreground/80">{preview}</p>
              )}
            </div>
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-xs whitespace-pre-wrap break-words">
        {entry.text}
      </TooltipContent>
    </Tooltip>
  );
};

type SortDir = 'asc' | 'desc';
const SORT_STORAGE_KEY = 'flowpad.promptIndexPanel.sortDir';

function readStoredSortDir(): SortDir {
  if (typeof window === 'undefined') return 'asc';
  try {
    return window.localStorage.getItem(SORT_STORAGE_KEY) === 'desc' ? 'desc' : 'asc';
  } catch {
    return 'asc';
  }
}

export const PromptIndexPanel: React.FC<PromptIndexPanelProps> = ({
  prompts,
  onScrollToLine,
  process = null,
  projectId,
}) => {
  const { t } = useLingui();
  const [sortDir, setSortDir] = useState<SortDir>(readStoredSortDir);

  // Pin-from-history: library prompts keyed by normalized text. Disabled
  // (no query) when the host doesn't supply a process.
  const pinningEnabled = !!process && projectId !== undefined;
  const { byNormalizedText, refresh: refreshLibrary } = useLibraryPromptsForProject(
    pinningEnabled ? (projectId ?? null) : undefined,
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(SORT_STORAGE_KEY, sortDir);
    } catch {
      // localStorage may be unavailable (private mode, quota) — preference simply doesn't persist.
    }
  }, [sortDir]);

  const sortedPrompts = useMemo(() => {
    const copy = [...prompts];
    copy.sort((a, b) => {
      const ta = Date.parse(a.time);
      const tb = Date.parse(b.time);
      const safeA = Number.isNaN(ta) ? 0 : ta;
      const safeB = Number.isNaN(tb) ? 0 : tb;
      return sortDir === 'asc' ? safeA - safeB : safeB - safeA;
    });
    return copy;
  }, [prompts, sortDir]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-1.5 border-b px-3 py-2">
        <span className="flex items-center gap-1.5">
          <MessageSquare className="h-3.5 w-3.5 text-lime-400" />
          <span className="text-sm font-medium"><Trans>Prompts ({prompts.length})</Trans></span>
        </span>
        <button
          type="button"
          title={
            sortDir === 'desc'
              ? t`Sort by time: newest first (click for oldest first)`
              : t`Sort by time: oldest first (click for newest first)`
          }
          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}
          data-testid="prompt-index-sort-time"
          aria-label={t`Sort prompts by time`}
        >
          {sortDir === 'desc' ? <ArrowDown className="h-3.5 w-3.5" /> : <ArrowUp className="h-3.5 w-3.5" />}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-1">
        {prompts.length === 0 ? (
          <p className="mt-4 px-2 text-center text-xs text-muted-foreground"><Trans>No prompts yet</Trans></p>
        ) : (
          <TooltipProvider delayDuration={600}>
            <div className="flex flex-col gap-0.5">
              {sortedPrompts.map((entry, i) => {
                const pinProcess = pinningEnabled ? process : null;
                const pinnedPrompt = pinProcess
                  ? (byNormalizedText.get(normalizePromptText(entry.text)) ?? null)
                  : null;
                return (
                  <PromptItem
                    key={`${entry.time}-${i}`}
                    entry={entry}
                    onScrollToLine={onScrollToLine}
                    isPinned={!!pinnedPrompt}
                    onTogglePin={
                      pinProcess
                        ? async () => {
                            if (pinnedPrompt) await pinProcess.unpinPrompt(pinnedPrompt.id);
                            else await pinProcess.pinPrompt(entry.text);
                            refreshLibrary();
                          }
                        : undefined
                    }
                  />
                );
              })}
            </div>
          </TooltipProvider>
        )}
      </div>
    </div>
  );
};
