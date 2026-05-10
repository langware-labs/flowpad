import { useState } from 'react';
import { Bot, ChevronDown, ChevronRight, Minus, Plus, Terminal, User, Zap } from 'lucide-react';

import { formatEntryTime, formatNumber, getToolFileSummary } from './transcript-utils';
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

/** First non-empty line of a multiline string, for collapsed tool previews. */
function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim())?.trim() ?? '';
}

/** Shared 70%-wide truncated preview span used in collapsed tool rows. */
function ToolPreview({ text }: { text: string }) {
  return <span className="w-[70%] truncate font-mono text-[10px] text-muted-foreground">{text}</span>;
}

export function ChatEntryItem({ entry, toolFilters, isExpanded, onToggle }: Props) {
  const [showThinking, setShowThinking] = useState(false);
  const [toolExpanded, setToolExpanded] = useState(false);
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

  // ── Assistant turn (text and/or tool_use) ─────────────────────────────────
  if (entry.role === 'assistant') {
    const text = entry.text ?? '';
    const thinking = entry.thinking ?? '';
    const tool = entry.toolUse;
    if (tool && toolFilters && toolFilters[tool.name] === false) return null;

    const canTruncate = needsTruncation(text);
    const isCollapsed = canTruncate && !isExpanded;
    const totalTokens = (entry.usage?.input ?? 0) + (entry.usage?.output ?? 0);

    return (
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-start gap-2.5">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-green-500/15">
            <Bot className="h-3.5 w-3.5 text-green-600" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-xs font-semibold text-green-600">Claude</span>
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

            {tool && (
              <div className="mt-2">
                <ToolCard
                  name={tool.name}
                  input={tool.input}
                  expanded={toolExpanded}
                  onToggle={() => setToolExpanded((v) => !v)}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return null;
}

function ToolCard({ name, input, expanded, onToggle }: { name: string; input: unknown; expanded: boolean; onToggle: () => void }) {
  const inp = (input ?? {}) as Record<string, unknown>;
  const fileParts = getToolFileSummary([{ name, input }]);
  const agentType = name === 'Agent' ? (inp.subagent_type as string | undefined) : null;
  const preview = name === 'Bash' && inp.command
    ? firstLine(inp.command as string)
    : name === 'Agent' && inp.description
    ? firstLine(inp.description as string)
    : null;
  return (
    <div className="rounded border border-border bg-muted/30">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-muted/50"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <Terminal className="h-3 w-3 shrink-0 text-orange-500" />
        <span className="font-mono text-[11px] font-medium">{name}</span>
        {agentType && (
          <span className="shrink-0 rounded bg-orange-500/10 px-1 font-mono text-[10px] text-orange-600">{agentType}</span>
        )}
        {preview ? (
          <ToolPreview text={preview} />
        ) : fileParts.length > 0 && (
          <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">{fileParts.join(', ')}</span>
        )}
      </button>
      {expanded && (
        <div className="border-t border-border px-2 pb-2 pt-1">
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">
            {JSON.stringify(input, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
