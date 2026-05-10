import { useState } from 'react';
import { ChevronDown, ChevronRight, Minus, Plus, User, Zap } from 'lucide-react';

import { OperationExpandedDetail, OperationOneLiner } from './OperationRow';
import { formatEntryTime, formatNumber, workerIcon, workerLabel } from './transcript-utils';
import type { UnifiedEntry } from './types';

interface Props {
  entry: UnifiedEntry;
  toolFilters?: Record<string, boolean>;
  isExpanded: boolean;
  onToggle: () => void;
}

function needsTruncation(text: string): boolean {
  return text.split('\n').length > 3 || text.length > 280;
}

export function ChatEntryItem({ entry, toolFilters, isExpanded, onToggle }: Props) {
  const [showThinking, setShowThinking] = useState(false);
  const [opExpanded, setOpExpanded] = useState(false);
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

  // ── Operation row (file_write / shell / search / tool_use catch-all) ──────
  if (entry.role === 'operation' && entry.operation) {
    const op = entry.operation;
    const filterKey = op.kind === 'tool_use' ? (op as { tool_name: string }).tool_name : op.kind;
    if (toolFilters && toolFilters[filterKey] === false) return null;
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
            </div>
            <button
              type="button"
              onClick={() => setOpExpanded((v) => !v)}
              className="flex w-full items-center gap-1.5 rounded border border-border bg-muted/30 px-2 py-1.5 text-left hover:bg-muted/50"
            >
              {opExpanded ? (
                <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
              )}
              <OperationOneLiner operation={op} />
            </button>
            {opExpanded && (
              <div className="mt-1 rounded border border-border bg-muted/30 p-2">
                <OperationExpandedDetail operation={op} />
              </div>
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

            {thinking && (
              <div className="mt-2">
                <button
                  type="button"
                  onClick={() => setShowThinking((v) => !v)}
                  className="flex items-center gap-1 text-[10px] text-purple-600 hover:text-purple-700"
                >
                  {showThinking ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  {showThinking ? 'Hide' : 'Show'} thinking
                </button>
                {showThinking && (
                  <div className="mt-1 rounded border border-purple-500/20 bg-purple-500/5 p-2">
                    <p className="whitespace-pre-wrap text-xs text-purple-700">{thinking}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return null;
}
