import { useState } from 'react';
import { Minus, Plus, Sparkles, User, Zap } from 'lucide-react';

import { formatEntryTime, formatNumber, workerIcon, workerLabel } from './transcript-utils';
import type { UnifiedEntry } from './types';

interface Props {
  entry: UnifiedEntry;
  isExpanded: boolean;
  onToggle: () => void;
  /** Advanced/Dev view shows per-turn token + cost chips; Standard hides them. */
  isAdvanced: boolean;
}

function needsTruncation(text: string): boolean {
  return text.split('\n').length > 3 || text.length > 280;
}

function thinkingExpansionKey(entry: UnifiedEntry): string {
  return `flowpad:transcript-thinking:${entry.sessionId}:${entry.id}`;
}

/** sessionStorage is absent under SSR/jsdom-without-storage; read and write
 * must agree on that, so both go through these two helpers. */
function readThinkingExpanded(entry: UnifiedEntry): boolean {
  if (typeof sessionStorage === 'undefined') return false;
  return sessionStorage.getItem(thinkingExpansionKey(entry)) === '1';
}

function writeThinkingExpanded(entry: UnifiedEntry, expanded: boolean): void {
  if (typeof sessionStorage === 'undefined') return;
  if (expanded) sessionStorage.setItem(thinkingExpansionKey(entry), '1');
  else sessionStorage.removeItem(thinkingExpansionKey(entry));
}

export function ChatEntryItem({ entry, isExpanded, onToggle, isAdvanced }: Props) {
  const [showThinking, setShowThinking] = useState(() => readThinkingExpanded(entry));
  const timestamp = formatEntryTime(entry);

  const toggleThinking = () => {
    setShowThinking((current) => {
      const next = !current;
      writeThinkingExpanded(entry, next);
      return next;
    });
  };

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
              {isAdvanced && entry.usage && totalTokens > 0 && (
                <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground">
                  <Zap className="h-2.5 w-2.5" />
                  {formatNumber(totalTokens)}
                </span>
              )}
              {isAdvanced && entry.usage?.costUsd != null && entry.usage.costUsd > 0 && (
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
                <div className="mt-3 ml-3 rounded-r border-l-2 border-purple-400/60 bg-purple-500/[0.04] py-1.5 pl-3 pr-2 dark:border-purple-300/40 dark:bg-purple-400/[0.06]">
                  <div className="mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-purple-600/80 dark:text-purple-300/80">
                    <Sparkles className="h-2.5 w-2.5" />
                    thinking
                  </div>
                  <p
                    className={`break-words font-serif text-[12px] italic leading-relaxed text-purple-800/85 dark:text-purple-200/80 ${
                      thinkingCollapsed ? 'line-clamp-3' : 'whitespace-pre-wrap'
                    }`}
                  >
                    {thinking}
                  </p>
                  {thinkingCanTruncate && (
                    <button
                      type="button"
                      onClick={toggleThinking}
                      className="mt-1.5 flex items-center gap-1 text-[11px] text-purple-600 hover:text-purple-700 dark:text-purple-300 dark:hover:text-purple-200"
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
