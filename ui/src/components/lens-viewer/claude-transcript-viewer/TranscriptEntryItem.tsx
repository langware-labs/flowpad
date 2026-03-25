import {
  Activity,
  AlertTriangle,
  Bot,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Info,
  Scissors,
  Square,
  Terminal,
  Timer,
  User,
  Zap,
} from 'lucide-react';
import {
  isAgentProgressData,
  isAssistantEntry,
  isBashProgressData,
  isProgressEntry,
  isTextBlock,
  isThinkingBlock,
  isToolUseBlock,
  isUserEntry,
  type AssistantContentBlock,
  type TranscriptEntry,
} from '@sdk';
import { formatDuration, formatEntryTime, formatNumber, getToolFileSummary, getToolSummary } from './transcript-utils';

export function TranscriptEntryItem({
  entry,
  isExpanded,
  onToggle,
  toolFilters,
  onInfo,
  onInfoHover,
  onInfoHoverEnd,
  onOpenTaskLink,
}: {
  entry: TranscriptEntry;
  isExpanded: boolean;
  onToggle: () => void;
  toolFilters?: Record<string, boolean>;
  onInfo: () => void;
  onInfoHover: () => void;
  onInfoHoverEnd: () => void;
  onOpenTaskLink?: (activeForm?: string) => void;
}) {
  const timestamp = formatEntryTime(entry);
  const isChild =
    ('parentUuid' in entry && !!entry.parentUuid) || ('parentToolUseID' in entry && !!entry.parentToolUseID);
  const indentWrapperClass = isChild ? 'ml-4' : '';
  const indentInnerClass = isChild ? 'border-l-2 border-border/60 pl-3' : '';
  const childMarker = isChild ? (
    <span className="mt-0.5 text-xs text-muted-foreground/70" aria-hidden="true">
      ↳
    </span>
  ) : null;

  if (isUserEntry(entry)) {
    const content =
      typeof entry.message.content === 'string'
        ? entry.message.content
        : entry.message.content
            .filter((c) => c.type === 'text')
            .map((c) => ('text' in c ? c.text : ''))
            .join('\n');

    return (
      <div className={`border-b border-border ${indentWrapperClass}`}>
        <div
          role="button"
          tabIndex={0}
          onClick={onToggle}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
          className={`flex w-full min-w-0 cursor-pointer items-start gap-2 p-2 text-left hover:bg-muted/30 ${indentInnerClass}`}
        >
          {isExpanded ? (
            <ChevronDown className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <ChevronRight className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          {childMarker}
          <User className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-blue-600">User</span>
              <span className="text-[10px] text-muted-foreground">{timestamp}</span>
              {entry.isSidechain && (
                <span className="rounded bg-purple-500/10 px-1 text-[10px] text-purple-600">sidechain</span>
              )}
            </div>
            <p className={`mt-0.5 break-all text-xs ${isExpanded ? '' : 'line-clamp-2'}`}>{content || '(empty)'}</p>
          </div>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onInfo(); }}
            onMouseEnter={(e) => { e.stopPropagation(); onInfoHover(); }}
            onMouseLeave={(e) => { e.stopPropagation(); onInfoHoverEnd(); }}
            className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted"
            title="Entry details"
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </div>
        {isExpanded && entry.toolUseResult && (
          <div className="ml-10 border-t border-border bg-muted/20 p-2">
            <p className="text-[10px] font-medium text-muted-foreground">Tool Result:</p>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10px]">
              {JSON.stringify(entry.toolUseResult, null, 2)}
            </pre>
          </div>
        )}
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
    const textContent = textBlocks.map((b) => b.text).join('\n');
    const fileSummary = getToolFileSummary(toolBlocks);

    return (
      <div className={`border-b border-border ${indentWrapperClass}`}>
        <div
          role="button"
          tabIndex={0}
          onClick={onToggle}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
          className={`flex w-full min-w-0 cursor-pointer items-start gap-2 p-2 text-left hover:bg-muted/30 ${indentInnerClass}`}
        >
          {isExpanded ? (
            <ChevronDown className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <ChevronRight className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          {childMarker}
          <Bot className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-green-600">Assistant</span>
              <span className="text-[10px] text-muted-foreground">{timestamp}</span>
              {toolBlocks.length > 0 && (
                <span className="rounded bg-orange-500/10 px-1 text-[10px] text-orange-600">
                  {toolBlocks.length} tool{toolBlocks.length !== 1 ? 's' : ''}
                </span>
              )}
              {fileSummary.length > 0 && (
                <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
                  {fileSummary.join(', ')}
                </span>
              )}
              {thinkingBlocks.length > 0 && (
                <span className="shrink-0 rounded bg-purple-500/10 px-1 text-[10px] text-purple-600">thinking</span>
              )}
              {entry.message.usage && (
                <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground">
                  <Zap className="h-2.5 w-2.5" />
                  {formatNumber(entry.message.usage.input_tokens + entry.message.usage.output_tokens)}
                </span>
              )}
            </div>
            <p className={`mt-0.5 break-all text-xs ${isExpanded ? '' : 'line-clamp-2'}`}>
              {textContent || '(no text content)'}
            </p>
          </div>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onInfo(); }}
            onMouseEnter={(e) => { e.stopPropagation(); onInfoHover(); }}
            onMouseLeave={(e) => { e.stopPropagation(); onInfoHoverEnd(); }}
            className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted"
            title="Entry details"
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </div>

        {isExpanded && (
          <div className="ml-10 space-y-2 border-t border-border bg-muted/20 p-2">
            {toolBlocks.map((tool, i) => (
              <div key={tool.id || i} className="rounded border border-border bg-background p-2">
                <div className="flex items-center gap-2">
                  <Terminal className="h-3 w-3 text-orange-500" />
                  <span className="font-mono text-xs font-medium">{tool.name}</span>
                  {onOpenTaskLink && (tool.name === 'TaskCreate' || tool.name === 'TaskUpdate') && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onOpenTaskLink(tool.input.activeForm as string | undefined); }}
                      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-primary hover:bg-muted"
                      title="Open in tasks viewer"
                    >
                      <ExternalLink className="h-3 w-3" />
                      Tasks
                    </button>
                  )}
                </div>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">
                  {JSON.stringify(tool.input, null, 2)}
                </pre>
              </div>
            ))}

            {thinkingBlocks.map((thinking, i) => (
              thinking.thinking ? (
                <div key={i} className="rounded border border-purple-500/20 bg-purple-500/5 p-2">
                  <p className="text-[10px] font-medium text-purple-600">Thinking:</p>
                  <p className="mt-1 whitespace-pre-wrap text-xs">{thinking.thinking}</p>
                </div>
              ) : (
                <span
                  key={i}
                  title={[
                    "Claude's internal reasoning — withheld by API.",
                    entry.message.usage && [
                      `Output: ${formatNumber(entry.message.usage.output_tokens)} tokens`,
                      entry.message.usage.cache_read_input_tokens && `Cache read: ${formatNumber(entry.message.usage.cache_read_input_tokens)}`,
                      entry.message.usage.cache_creation_input_tokens && `Cache write: ${formatNumber(entry.message.usage.cache_creation_input_tokens)}`,
                    ].filter(Boolean).join(' · '),
                  ].filter(Boolean).join('\n')}
                  className="inline-block cursor-default rounded bg-purple-500/10 px-1.5 py-0.5 text-[10px] italic text-purple-400/70"
                >
                  internal thinking
                </span>
              )
            ))}

            {entry.message.usage && (
              <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground">
                <span>Input: {formatNumber(entry.message.usage.input_tokens)}</span>
                <span>Output: {formatNumber(entry.message.usage.output_tokens)}</span>
                {entry.message.usage.cache_read_input_tokens && (
                  <span className="text-green-600">
                    Cache read: {formatNumber(entry.message.usage.cache_read_input_tokens)}
                  </span>
                )}
                {entry.message.usage.cache_creation_input_tokens && (
                  <span className="text-orange-600">
                    Cache write: {formatNumber(entry.message.usage.cache_creation_input_tokens)}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  if (isProgressEntry(entry)) {
    const data = entry.data;

    if (isBashProgressData(data)) {
      return (
        <div className={`border-b border-border ${indentWrapperClass}`}>
          <button
            onClick={onToggle}
            className={`flex w-full min-w-0 items-start gap-2 p-2 text-left hover:bg-muted/30 ${indentInnerClass}`}
          >
            {isExpanded ? (
              <ChevronDown className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <ChevronRight className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <Terminal className="mt-0.5 h-4 w-4 shrink-0 text-yellow-500" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="rounded bg-yellow-500/10 px-1.5 py-0.5 text-[10px] text-yellow-600">
                  bash progress
                </span>
                <span className="text-[10px] text-muted-foreground">{timestamp}</span>
                <span className="text-[10px] text-muted-foreground">{data.elapsedTimeSeconds}s</span>
              </div>
              <p className={`mt-0.5 break-all font-mono text-[10px] ${isExpanded ? '' : 'line-clamp-2'}`}>
                {data.output || '(running...)'}
              </p>
            </div>
          </button>
          {isExpanded && data.fullOutput && (
            <div className="ml-10 border-t border-border bg-muted/20 p-2">
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap font-mono text-[10px]">{data.fullOutput}</pre>
            </div>
          )}
        </div>
      );
    }

    if (isAgentProgressData(data)) {
      const isUserMsg = data.message?.type === 'user';
      const isAssistantMsg = data.message?.type === 'assistant';

      const agentMsg = isAssistantMsg
        ? (
            data.message as {
              message: {
                content: unknown[];
                usage?: {
                  input_tokens: number;
                  output_tokens: number;
                  cache_read_input_tokens?: number;
                  cache_creation_input_tokens?: number;
                };
              };
            }
          ).message
        : null;
      const agentContent = (agentMsg?.content ?? []) as AssistantContentBlock[];
      const textBlocks = agentContent.filter(isTextBlock);
      const toolBlocks = agentContent.filter(isToolUseBlock).filter((tool) => {
        if (!toolFilters) return true;
        return toolFilters[tool.name] !== false;
      });
      const thinkingBlocks = agentContent.filter(isThinkingBlock);
      const textContent = textBlocks.map((b) => b.text).join('\n');
      const fileSummary = getToolFileSummary(toolBlocks);

      const userMsg = isUserMsg ? (data.message as { message: { content: unknown[] }; toolUseResult?: string }) : null;
      const toolUseResult = userMsg?.toolUseResult;
      const userContent = (userMsg?.message?.content ?? []) as {
        type: string;
        content?: string;
        is_error?: boolean;
        tool_use_id?: string;
      }[];
      const toolResults = userContent.filter((c) => c.type === 'tool_result');
      const hasError = toolResults.some((r) => r.is_error);

      let collapsedText: string;
      if (isUserMsg) {
        collapsedText =
          toolUseResult ||
          toolResults.map((r) => (typeof r.content === 'string' ? r.content : '')).join('\n') ||
          '(tool result)';
      } else {
        collapsedText = textContent || toolBlocks.map((t) => getToolSummary(t)).join(', ') || '(no content)';
      }

      return (
        <div className={`border-b border-border ${indentWrapperClass}`}>
          <div
            role="button"
            tabIndex={0}
            onClick={onToggle}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
            className={`flex w-full min-w-0 cursor-pointer items-start gap-2 p-2 text-left hover:bg-muted/30 ${indentInnerClass}`}
          >
            {isExpanded ? (
              <ChevronDown className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <ChevronRight className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            {childMarker}
            {isUserMsg ? (
              <User className="mt-0.5 h-4 w-4 shrink-0 text-cyan-500" />
            ) : (
              <Bot className="mt-0.5 h-4 w-4 shrink-0 text-cyan-500" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="rounded bg-cyan-500/10 px-1.5 py-0.5 text-[10px] text-cyan-600">agent</span>
                <span className="font-mono text-[10px] text-muted-foreground">{data.agentId}</span>
                <span className="text-[10px] text-muted-foreground">{timestamp}</span>
                {isUserMsg && toolResults.length > 0 && (
                  <span
                    className={`rounded px-1 text-[10px] ${hasError ? 'bg-red-500/10 text-red-600' : 'bg-blue-500/10 text-blue-600'}`}
                  >
                    {hasError ? 'error' : 'tool result'}
                  </span>
                )}
                {toolBlocks.length > 0 && (
                  <span className="rounded bg-orange-500/10 px-1 text-[10px] text-orange-600">
                    {toolBlocks.length} tool{toolBlocks.length !== 1 ? 's' : ''}
                  </span>
                )}
                {fileSummary.length > 0 && (
                  <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
                    {fileSummary.join(', ')}
                  </span>
                )}
                {thinkingBlocks.length > 0 && (
                  <span className="shrink-0 rounded bg-purple-500/10 px-1 text-[10px] text-purple-600">thinking</span>
                )}
                {agentMsg?.usage && (
                  <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground">
                    <Zap className="h-2.5 w-2.5" />
                    {formatNumber(agentMsg.usage.input_tokens + agentMsg.usage.output_tokens)}
                  </span>
                )}
              </div>
              <p
                className={`mt-0.5 break-all text-xs ${isExpanded ? '' : 'line-clamp-2'} ${hasError ? 'text-red-500' : ''}`}
              >
                {collapsedText}
              </p>
            </div>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onInfo(); }}
              onMouseEnter={(e) => { e.stopPropagation(); onInfoHover(); }}
              onMouseLeave={(e) => { e.stopPropagation(); onInfoHoverEnd(); }}
              className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted"
              title="Entry details"
            >
              <Info className="h-3.5 w-3.5" />
            </button>
          </div>

          {isExpanded && (
            <div className="ml-10 space-y-2 border-t border-border bg-muted/20 p-2">
              {data.prompt && (
                <div className="rounded border border-cyan-500/20 bg-cyan-500/5 p-2">
                  <p className="text-[10px] font-medium text-cyan-600">Prompt:</p>
                  <p className="mt-1 whitespace-pre-wrap text-xs">{data.prompt}</p>
                </div>
              )}

              {toolResults.map((result, i) => (
                <div
                  key={i}
                  className={`rounded border p-2 ${result.is_error ? 'border-red-500/20 bg-red-500/5' : 'border-border bg-background'}`}
                >
                  <div className="flex items-center gap-2">
                    <Terminal className="h-3 w-3 text-orange-500" />
                    <span className={`font-mono text-xs font-medium ${result.is_error ? 'text-red-600' : ''}`}>
                      tool result{result.is_error ? ' (error)' : ''}
                    </span>
                  </div>
                  <pre
                    className={`mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10px] ${result.is_error ? 'text-red-500' : 'text-muted-foreground'}`}
                  >
                    {typeof result.content === 'string' ? result.content : JSON.stringify(result.content, null, 2)}
                  </pre>
                </div>
              ))}

              {toolBlocks.map((tool, i) => (
                <div key={tool.id || i} className="rounded border border-border bg-background p-2">
                  <div className="flex items-center gap-2">
                    <Terminal className="h-3 w-3 text-orange-500" />
                    <span className="font-mono text-xs font-medium">{tool.name}</span>
                    {onOpenTaskLink && (tool.name === 'TaskCreate' || tool.name === 'TaskUpdate') && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onOpenTaskLink(tool.input.activeForm as string | undefined); }}
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-primary hover:bg-muted"
                        title="Open in tasks viewer"
                      >
                        <ExternalLink className="h-3 w-3" />
                        Tasks
                      </button>
                    )}
                  </div>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">
                    {JSON.stringify(tool.input, null, 2)}
                  </pre>
                </div>
              ))}

              {thinkingBlocks.map((thinking, i) => (
                thinking.thinking ? (
                  <div key={i} className="rounded border border-purple-500/20 bg-purple-500/5 p-2">
                    <p className="text-[10px] font-medium text-purple-600">Thinking:</p>
                    <p className="mt-1 whitespace-pre-wrap text-xs">{thinking.thinking}</p>
                  </div>
                ) : (
                  <span
                    key={i}
                    title={[
                      "Claude's internal reasoning — withheld by API.",
                      agentMsg?.usage && [
                        `Output: ${formatNumber(agentMsg.usage.output_tokens)} tokens`,
                        agentMsg.usage.cache_read_input_tokens && `Cache read: ${formatNumber(agentMsg.usage.cache_read_input_tokens)}`,
                        agentMsg.usage.cache_creation_input_tokens && `Cache write: ${formatNumber(agentMsg.usage.cache_creation_input_tokens)}`,
                      ].filter(Boolean).join(' · '),
                    ].filter(Boolean).join('\n')}
                    className="inline-block cursor-default rounded bg-purple-500/10 px-1.5 py-0.5 text-[10px] italic text-purple-400/70"
                  >
                    internal thinking
                  </span>
                )
              ))}

              {agentMsg?.usage && (
                <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground">
                  <span>Input: {formatNumber(agentMsg.usage.input_tokens)}</span>
                  <span>Output: {formatNumber(agentMsg.usage.output_tokens)}</span>
                  {agentMsg.usage.cache_read_input_tokens && (
                    <span className="text-green-600">
                      Cache read: {formatNumber(agentMsg.usage.cache_read_input_tokens)}
                    </span>
                  )}
                  {agentMsg.usage.cache_creation_input_tokens && (
                    <span className="text-orange-600">
                      Cache write: {formatNumber(agentMsg.usage.cache_creation_input_tokens)}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      );
    }

    // hook_progress fallback
    return (
      <div className={`border-b border-border ${indentWrapperClass}`}>
        <div
          role="button"
          tabIndex={0}
          onClick={onToggle}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
          className={`flex w-full min-w-0 cursor-pointer items-start gap-2 p-2 text-left hover:bg-muted/30 ${indentInnerClass}`}
        >
          {isExpanded ? (
            <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <Zap className="mt-0.5 h-4 w-4 shrink-0 text-purple-400" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="rounded bg-purple-500/10 px-1.5 py-0.5 text-[10px] text-purple-500">hook</span>
              <span className="truncate font-mono text-[10px] text-muted-foreground">{data.hookName}</span>
              <span className="text-[10px] text-muted-foreground">{timestamp}</span>
            </div>
            {!isExpanded && (
              <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/70">{data.hookEvent}</p>
            )}
          </div>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onInfo(); }}
            onMouseEnter={(e) => { e.stopPropagation(); onInfoHover(); }}
            onMouseLeave={(e) => { e.stopPropagation(); onInfoHoverEnd(); }}
            className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted"
            title="Entry details"
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </div>
        {isExpanded && (
          <div className="ml-10 border-t border-border bg-muted/20 p-2">
            <div className="space-y-1 text-[10px]">
              <div>
                <span className="text-muted-foreground">Event: </span>
                <span className="font-mono">{data.hookEvent}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Hook: </span>
                <span className="font-mono">{data.hookName}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Command: </span>
                <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[9px] text-muted-foreground">
                  {data.command}
                </pre>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  const raw = entry as any;
  const subtype: string | undefined = raw.subtype;

  if (entry.type === 'system' && subtype === 'turn_duration') {
    const durationMs: number = raw.durationMs ?? 0;
    return (
      <div className={indentWrapperClass}>
        <div
          className={`flex min-w-0 items-center gap-2 border-b border-border p-2 text-xs text-muted-foreground ${indentInnerClass}`}
        >
          {childMarker}
          <Timer className="h-3 w-3 text-blue-400" />
          <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-600">turn duration</span>
          <span className="font-medium text-foreground">{formatDuration(durationMs)}</span>
          <span className="shrink-0">{timestamp}</span>
          <button
            type="button"
            onClick={onInfo}
            onMouseEnter={onInfoHover}
            onMouseLeave={onInfoHoverEnd}
            className="ml-auto inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted"
            title="Entry details"
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  }

  if (entry.type === 'system' && subtype === 'stop_hook_summary') {
    const hookCount: number = raw.hookCount ?? 0;
    const hookInfos: { command: string }[] = raw.hookInfos ?? [];
    const hookErrors: string[] = raw.hookErrors ?? [];
    const stopReason: string = raw.stopReason || '';
    const preventedContinuation: boolean = raw.preventedContinuation ?? false;

    return (
      <div className={`border-b border-border ${indentWrapperClass}`}>
        <div
          role="button"
          tabIndex={0}
          onClick={onToggle}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
          className={`flex w-full min-w-0 cursor-pointer items-start gap-2 p-2 text-left hover:bg-muted/30 ${indentInnerClass}`}
        >
          {isExpanded ? (
            <ChevronDown className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <ChevronRight className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          {childMarker}
          <Square className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-500" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="rounded bg-orange-500/10 px-1.5 py-0.5 text-[10px] font-medium text-orange-600">
                stop hooks
              </span>
              <span className="text-[10px] text-muted-foreground">{timestamp}</span>
              <span className="text-[10px] text-muted-foreground">
                {hookCount} hook{hookCount !== 1 ? 's' : ''}
              </span>
              {hookErrors.length > 0 && (
                <span className="flex items-center gap-0.5 rounded bg-red-500/10 px-1 text-[10px] text-red-600">
                  <AlertTriangle className="h-2.5 w-2.5" />
                  {hookErrors.length} error{hookErrors.length !== 1 ? 's' : ''}
                </span>
              )}
              {preventedContinuation && (
                <span className="rounded bg-red-500/10 px-1 text-[10px] text-red-600">blocked</span>
              )}
              {stopReason && <span className="truncate text-[10px] text-muted-foreground">{stopReason}</span>}
            </div>
          </div>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onInfo(); }}
            onMouseEnter={(e) => { e.stopPropagation(); onInfoHover(); }}
            onMouseLeave={(e) => { e.stopPropagation(); onInfoHoverEnd(); }}
            className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted"
            title="Entry details"
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </div>
        {isExpanded && (
          <div className="ml-10 space-y-1 border-t border-border bg-muted/20 p-2">
            {hookInfos.map((hook, i) => (
              <div key={i} className="rounded border border-border bg-background px-2 py-1">
                <pre className="whitespace-pre-wrap break-all font-mono text-[10px] text-muted-foreground">
                  {hook.command}
                </pre>
              </div>
            ))}
            {hookErrors.length > 0 && (
              <div className="space-y-1">
                {hookErrors.map((err, i) => (
                  <div key={i} className="rounded border border-red-500/20 bg-red-500/5 px-2 py-1">
                    <pre className="whitespace-pre-wrap break-all font-mono text-[10px] text-red-600">
                      {typeof err === 'string' ? err : JSON.stringify(err)}
                    </pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  if (entry.type === 'system' && subtype === 'compact_boundary') {
    return (
      <div className={indentWrapperClass}>
        <div
          className={`flex min-w-0 items-center gap-2 border-b border-border p-2 text-xs text-muted-foreground ${indentInnerClass}`}
        >
          {childMarker}
          <Scissors className="h-3 w-3 text-purple-400" />
          <span className="rounded bg-purple-500/10 px-1.5 py-0.5 text-[10px] text-purple-600">compact boundary</span>
          <span className="shrink-0">{timestamp}</span>
          <button
            type="button"
            onClick={onInfo}
            onMouseEnter={onInfoHover}
            onMouseLeave={onInfoHoverEnd}
            className="ml-auto inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted"
            title="Entry details"
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={indentWrapperClass}>
      <div
        className={`flex min-w-0 items-center gap-2 border-b border-border p-2 text-xs text-muted-foreground ${indentInnerClass}`}
      >
        {childMarker}
        <Activity className="h-3 w-3" />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="min-w-0 break-all rounded bg-muted px-1.5 py-0.5">{entry.type}</span>
          {subtype && <span className="rounded bg-muted px-1 text-[10px]">{subtype}</span>}
          <span className="shrink-0">{timestamp}</span>
        </div>
        <button
          type="button"
          onClick={onInfo}
          onMouseEnter={onInfoHover}
          onMouseLeave={onInfoHoverEnd}
          className="ml-auto inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted"
          title="Entry details"
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
