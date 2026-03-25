import { useState } from 'react';
import { Bot, ChevronDown, ChevronRight, Minus, Plus, Terminal, User, Zap } from 'lucide-react';
import {
  isAssistantEntry,
  isTextBlock,
  isThinkingBlock,
  isToolUseBlock,
  isUserEntry,
  type TranscriptEntry,
} from '@sdk';
import { formatEntryTime, formatNumber, getToolFileSummary } from './transcript-utils';

interface Props {
  entry: TranscriptEntry;
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
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [showThinking, setShowThinking] = useState(false);
  const timestamp = formatEntryTime(entry);

  const toggleTool = (id: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (isUserEntry(entry)) {
    const content =
      typeof entry.message.content === 'string'
        ? entry.message.content
        : entry.message.content
            .filter((c) => c.type === 'text')
            .map((c) => ('text' in c ? c.text : ''))
            .join('\n');

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

  if (isAssistantEntry(entry)) {
    const textBlocks = entry.message.content.filter(isTextBlock);
    const toolBlocks = entry.message.content.filter(isToolUseBlock).filter((tool) => {
      if (!toolFilters) return true;
      return toolFilters[tool.name] !== false;
    });
    const thinkingBlocks = entry.message.content.filter(isThinkingBlock);
    const hasVisibleThinking = thinkingBlocks.some((t) => t.thinking);
    const textContent = textBlocks.map((b) => b.text).join('\n');

    const canTruncate = needsTruncation(textContent);
    const isCollapsed = canTruncate && !isExpanded;

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
              {entry.message.usage && (
                <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground">
                  <Zap className="h-2.5 w-2.5" />
                  {formatNumber(entry.message.usage.input_tokens + entry.message.usage.output_tokens)}
                </span>
              )}
            </div>

            {textContent && (
              <>
                <p className={`break-words text-sm leading-relaxed text-foreground/80 ${isCollapsed ? 'line-clamp-3' : 'whitespace-pre-wrap'}`}>
                  {textContent}
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

            {/* Thinking toggle — only shown when there is visible (non-encrypted) content */}
            {hasVisibleThinking && (
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
                    {thinkingBlocks.map((t, i) => (
                      t.thinking
                        ? <p key={i} className="whitespace-pre-wrap text-xs text-purple-700">{t.thinking}</p>
                        : <p key={i} className="italic text-[10px] text-purple-400/60">(internal thinking — encrypted by API)</p>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Tool calls as compact rows */}
            {toolBlocks.length > 0 && (
              <div className="mt-2 space-y-1">
                {toolBlocks.map((tool, i) => {
                  const toolKey = tool.id || String(i);
                  const isToolExpanded = expandedTools.has(toolKey);
                  const inp = tool.input as Record<string, unknown>;
                  const fileParts = getToolFileSummary([tool]);
                  const agentType = tool.name === 'Agent' ? (inp.subagent_type as string | undefined) : null;
                  const preview = tool.name === 'Bash' && inp.command
                    ? firstLine(inp.command as string)
                    : tool.name === 'Agent' && inp.description
                    ? firstLine(inp.description as string)
                    : null;
                  return (
                    <div key={toolKey} className="rounded border border-border bg-muted/30">
                      <button
                        type="button"
                        onClick={() => toggleTool(toolKey)}
                        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-muted/50"
                      >
                        {isToolExpanded ? (
                          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                        )}
                        <Terminal className="h-3 w-3 shrink-0 text-orange-500" />
                        <span className="font-mono text-[11px] font-medium">{tool.name}</span>
                        {agentType && (
                          <span className="shrink-0 rounded bg-orange-500/10 px-1 font-mono text-[10px] text-orange-600">{agentType}</span>
                        )}
                        {preview ? (
                          <ToolPreview text={preview} />
                        ) : fileParts.length > 0 && (
                          <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
                            {fileParts.join(', ')}
                          </span>
                        )}
                      </button>
                      {isToolExpanded && (
                        <div className="border-t border-border px-2 pb-2 pt-1">
                          <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">
                            {JSON.stringify(tool.input, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return null;
}
