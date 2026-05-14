import { useState } from 'react';
import { Minus, Plus, User, Zap } from 'lucide-react';

import { formatEntryTime, formatNumber, workerIcon, workerLabel } from './transcript-utils';
import type { UnifiedEntry } from './types';

interface Props {
  entry: UnifiedEntry;
  isExpanded: boolean;
  onToggle: () => void;
}

function needsTruncation(text: string): boolean {
  return text.split('\n').length > 3 || text.length > 280;
}

export function ChatEntryItem({ entry, isExpanded, onToggle }: Props) {
  const [showThinking, setShowThinking] = useState(false);
  const timestamp = formatEntryTime(entry);

  // ── User turn (text body) ──────────────────────────────────────────────────
  if (entry.role === 'user' && entry.text) {
    const content = entry.text;
    const canTruncate = needsTruncation(content);
    const isCollapsed = canTruncate && !isExpanded;
    return (
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-start gap-2.5">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-500/15">
            <User className="h-3.5 w-3.5 text-blue-500" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-xs font-semibold text-blue-600">You</span>
              <span className="text-[10px] text-muted-foreground">{timestamp}</span>
              {entry.isSidechain && (
                <span className="rounded bg-purple-500/10 px-1 text-[10px] text-purple-600">sidechain</span>
              )}
            </div>
            <p className={`break-words text-sm leading-relaxed text-blue-700 dark:text-blue-300 ${isCollapsed ? 'line-clamp-3' : 'whitespace-pre-wrap'}`}>
              {content || '(empty)'}
            </p>
            {canTruncate && (
              <button
                type="button"
                onClick={onToggle}
                className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              >
                {isExpanded ? <Minus className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
                {isExpanded ? 'Show less' : 'Show more'}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Assistant text turn (+ optional thinking + usage) ──────────────────────
  if (entry.role === 'assistant') {
    const text = entry.text ?? '';
    const thinking = entry.thinking ?? '';

    const canTruncate = needsTruncation(text);
    const isCollapsed = canTruncate && !isExpanded;
    const totalTokens = (entry.usage?.input ?? 0) + (entry.usage?.output ?? 0);
    const WorkerIcon = workerIcon(entry.worker);

    return (
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-start gap-2.5">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-green-500/15">
            <WorkerIcon className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-xs font-semibold text-foreground/80">{workerLabel(entry.worker)}</span>
              <span className="text-[10px] text-muted-foreground">{timestamp}</span>
              {entry.isSidechain && (
                <span className="rounded bg-purple-500/10 px-1 text-[10px] text-purple-600">sidechain</span>
              )}
              {entry.usage && totalTokens > 0 && (
                <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground">
                  <Zap className="h-2.5 w-2.5" />
                  {formatNumber(totalTokens)}
                </span>
              )}
              {entry.usage?.costUsd != null && entry.usage.costUsd > 0 && (
                <span
                  className="shrink-0 text-[10px] font-medium tabular-nums text-foreground/80"
                  data-testid="turn-cost-usd"
                  title={`${entry.usage.model ?? 'unknown model'} · cost for this turn`}
                >
                  ${entry.usage.costUsd < 0.01
                    ? entry.usage.costUsd.toFixed(4)
                    : entry.usage.costUsd.toFixed(3)}
                </span>
              )}
            </div>

            {text && (
              <>
                <p className={`break-words text-sm leading-relaxed text-foreground/80 ${isCollapsed ? 'line-clamp-3' : 'whitespace-pre-wrap'}`}>
                  {text}
                </p>
                {canTruncate && (
                  <button
                    type="button"
                    onClick={onToggle}
                    className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    {isExpanded ? <Minus className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
                    {isExpanded ? 'Show less' : 'Show more'}
                  </button>
                )}
              </>
            )}

            {thinking && (() => {
              const thinkingCanTruncate = needsTruncation(thinking);
              const thinkingCollapsed = thinkingCanTruncate && !showThinking;
              return (
                <div className="mt-2 rounded border border-purple-500/20 bg-purple-500/5 p-2">
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-purple-600">
                    thinking
                  </div>
                  <p
                    className={`break-words text-xs leading-relaxed text-purple-700 dark:text-purple-300 ${
                      thinkingCollapsed ? 'line-clamp-3' : 'whitespace-pre-wrap'
                    }`}
                  >
                    {thinking}
                  </p>
                  {thinkingCanTruncate && (
                    <button
                      type="button"
                      onClick={() => setShowThinking((v) => !v)}
                      className="mt-1.5 flex items-center gap-1 text-[11px] text-purple-600 hover:text-purple-700"
                    >
                      {showThinking ? <Minus className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
                      {showThinking ? 'Show less' : 'Show more'}
                    </button>
                  )}
                </div>
              );
            })()}
          </div>
        </div>
      </div>
    );
  }

  return null;
}
