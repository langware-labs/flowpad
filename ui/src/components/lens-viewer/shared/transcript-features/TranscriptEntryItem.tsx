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

import { formatDuration, formatEntryTime, formatNumber, getToolFileSummary } from './transcript-utils';
import type { UnifiedEntry } from './types';

interface Props {
  entry: UnifiedEntry;
  isExpanded: boolean;
  onToggle: () => void;
  toolFilters?: Record<string, boolean>;
  onInfo: () => void;
  onInfoHover: () => void;
  onInfoHoverEnd: () => void;
  onOpenTaskLink?: (activeForm?: string) => void;
}

export function TranscriptEntryItem({
  entry,
  isExpanded,
  onToggle,
  toolFilters,
  onInfo,
  onInfoHover,
  onInfoHoverEnd,
  onOpenTaskLink,
}: Props) {
  const timestamp = formatEntryTime(entry);
  // Sidechain entries get visual indent — same hierarchy hint as legacy.
  const isChild = !!entry.parentId || entry.isSidechain;
  const indentWrapperClass = isChild ? 'ml-4' : '';
  const indentInnerClass = isChild ? 'border-l-2 border-border/60 pl-3' : '';
  const childMarker = isChild ? (
    <span className="mt-0.5 text-xs text-muted-foreground/70" aria-hidden="true">↳</span>
  ) : null;

  // ── User turn (text and/or tool_result) ────────────────────────────────────
  if (entry.role === 'user') {
    const hasToolResult = !!entry.toolResult;
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
              {hasToolResult && (
                <span className={`rounded px-1 text-[10px] ${entry.toolResult!.isError ? 'bg-red-500/10 text-red-600' : 'bg-blue-500/10 text-blue-600'}`}>
                  {entry.toolResult!.isError ? 'tool error' : 'tool result'}
                </span>
              )}
            </div>
            <p className={`mt-0.5 break-all text-xs ${isExpanded ? '' : 'line-clamp-2'} ${entry.toolResult?.isError ? 'text-red-500' : ''}`}>
              {entry.text || (hasToolResult ? entry.toolResult!.output.slice(0, 200) : '(empty)')}
            </p>
          </div>
          <InfoButton onInfo={onInfo} onInfoHover={onInfoHover} onInfoHoverEnd={onInfoHoverEnd} />
        </div>
        {isExpanded && hasToolResult && (
          <div className="ml-10 border-t border-border bg-muted/20 p-2">
            <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
              {entry.toolResult!.filePath && (
                <span className="font-mono">{entry.toolResult!.filePath}</span>
              )}
              {entry.toolResult!.durationMs != null && (
                <span>{formatDuration(entry.toolResult!.durationMs)}</span>
              )}
              {entry.toolResult!.exitCode != null && (
                <span>exit {entry.toolResult!.exitCode}</span>
              )}
            </div>
            <pre className={`mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10px] ${entry.toolResult!.isError ? 'text-red-500' : 'text-muted-foreground'}`}>
              {entry.toolResult!.output}
            </pre>
          </div>
        )}
      </div>
    );
  }

  // ── Assistant turn (text + thinking + tool_use + usage) ─────────────────────
  if (entry.role === 'assistant') {
    const tool = entry.toolUse;
    if (tool && toolFilters && toolFilters[tool.name] === false) return null;
    const fileSummary = tool ? getToolFileSummary([{ name: tool.name, input: tool.input }]) : [];
    const totalTokens = (entry.usage?.input ?? 0) + (entry.usage?.output ?? 0);
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
              {tool && (
                <span className="rounded bg-orange-500/10 px-1 text-[10px] text-orange-600">{tool.name}</span>
              )}
              {fileSummary.length > 0 && (
                <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
                  {fileSummary.join(', ')}
                </span>
              )}
              {entry.thinking && (
                <span className="shrink-0 rounded bg-purple-500/10 px-1 text-[10px] text-purple-600">thinking</span>
              )}
              {entry.usage && totalTokens > 0 && (
                <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground">
                  <Zap className="h-2.5 w-2.5" />
                  {formatNumber(totalTokens)}
                </span>
              )}
            </div>
            <p className={`mt-0.5 break-all text-xs ${isExpanded ? '' : 'line-clamp-2'}`}>
              {entry.text || (tool ? `${tool.name}(...)` : '(no text content)')}
            </p>
          </div>
          <InfoButton onInfo={onInfo} onInfoHover={onInfoHover} onInfoHoverEnd={onInfoHoverEnd} />
        </div>

        {isExpanded && (
          <div className="ml-10 space-y-2 border-t border-border bg-muted/20 p-2">
            {tool && (
              <div className="rounded border border-border bg-background p-2">
                <div className="flex items-center gap-2">
                  <Terminal className="h-3 w-3 text-orange-500" />
                  <span className="font-mono text-xs font-medium">{tool.name}</span>
                  {onOpenTaskLink && (tool.name === 'TaskCreate' || tool.name === 'TaskUpdate') && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        const inp = (tool.input ?? {}) as { activeForm?: string };
                        onOpenTaskLink(inp.activeForm);
                      }}
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
            )}

            {entry.thinking && (
              <div className="rounded border border-purple-500/20 bg-purple-500/5 p-2">
                <p className="text-[10px] font-medium text-purple-600">Thinking:</p>
                <p className="mt-1 whitespace-pre-wrap text-xs">{entry.thinking}</p>
              </div>
            )}

            {entry.usage && (
              <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground">
                <span>Input: {formatNumber(entry.usage.input ?? 0)}</span>
                <span>Output: {formatNumber(entry.usage.output ?? 0)}</span>
                {entry.usage.cacheRead != null && entry.usage.cacheRead > 0 && (
                  <span className="text-green-600">Cache read: {formatNumber(entry.usage.cacheRead)}</span>
                )}
                {entry.usage.cacheCreation != null && entry.usage.cacheCreation > 0 && (
                  <span className="text-orange-600">Cache write: {formatNumber(entry.usage.cacheCreation)}</span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // ── System / progress / hooks (subtype-driven) ─────────────────────────────
  if (entry.role === 'system') {
    const subtype = entry.subtype || '';
    const payload = entry.payload || {};

    if (subtype === 'bash_progress') {
      const elapsed = (payload.elapsedTimeSeconds as number | undefined) ?? 0;
      const output = (payload.output as string | undefined) ?? '';
      const fullOutput = (payload.fullOutput as string | undefined) ?? '';
      return (
        <div className={`border-b border-border ${indentWrapperClass}`}>
          <button
            onClick={onToggle}
            className={`flex w-full min-w-0 items-start gap-2 p-2 text-left hover:bg-muted/30 ${indentInnerClass}`}
          >
            {isExpanded ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0" /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0" />}
            <Terminal className="mt-0.5 h-4 w-4 shrink-0 text-yellow-500" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="rounded bg-yellow-500/10 px-1.5 py-0.5 text-[10px] text-yellow-600">bash progress</span>
                <span className="text-[10px] text-muted-foreground">{timestamp}</span>
                <span className="text-[10px] text-muted-foreground">{elapsed}s</span>
              </div>
              <p className={`mt-0.5 break-all font-mono text-[10px] ${isExpanded ? '' : 'line-clamp-2'}`}>
                {output || '(running...)'}
              </p>
            </div>
          </button>
          {isExpanded && fullOutput && (
            <div className="ml-10 border-t border-border bg-muted/20 p-2">
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap font-mono text-[10px]">{fullOutput}</pre>
            </div>
          )}
        </div>
      );
    }

    if (subtype === 'turn_duration') {
      const durationMs = (payload.durationMs as number | undefined) ?? 0;
      return (
        <div className={indentWrapperClass}>
          <div className={`flex min-w-0 items-center gap-2 border-b border-border p-2 text-xs text-muted-foreground ${indentInnerClass}`}>
            {childMarker}
            <Timer className="h-3 w-3 text-blue-400" />
            <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-600">turn duration</span>
            <span className="font-medium text-foreground">{formatDuration(durationMs)}</span>
            <span className="shrink-0">{timestamp}</span>
            <InfoButton onInfo={onInfo} onInfoHover={onInfoHover} onInfoHoverEnd={onInfoHoverEnd} className="ml-auto" />
          </div>
        </div>
      );
    }

    if (subtype === 'compact_boundary') {
      return (
        <div className={indentWrapperClass}>
          <div className={`flex min-w-0 items-center gap-2 border-b border-border p-2 text-xs text-muted-foreground ${indentInnerClass}`}>
            {childMarker}
            <Scissors className="h-3 w-3 text-purple-400" />
            <span className="rounded bg-purple-500/10 px-1.5 py-0.5 text-[10px] text-purple-600">compact boundary</span>
            <span className="shrink-0">{timestamp}</span>
            <InfoButton onInfo={onInfo} onInfoHover={onInfoHover} onInfoHoverEnd={onInfoHoverEnd} className="ml-auto" />
          </div>
        </div>
      );
    }

    if (subtype === 'stop_hook_summary') {
      const hookCount = (payload.hookCount as number | undefined) ?? 0;
      const hookInfos = (payload.hookInfos as { command: string }[] | undefined) ?? [];
      const hookErrors = (payload.hookErrors as string[] | undefined) ?? [];
      const stopReason = (payload.stopReason as string | undefined) ?? '';
      const preventedContinuation = (payload.preventedContinuation as boolean | undefined) ?? false;
      return (
        <div className={`border-b border-border ${indentWrapperClass}`}>
          <div
            role="button"
            tabIndex={0}
            onClick={onToggle}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
            className={`flex w-full min-w-0 cursor-pointer items-start gap-2 p-2 text-left hover:bg-muted/30 ${indentInnerClass}`}
          >
            {isExpanded ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0" /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0" />}
            {childMarker}
            <Square className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-500" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="rounded bg-orange-500/10 px-1.5 py-0.5 text-[10px] font-medium text-orange-600">stop hooks</span>
                <span className="text-[10px] text-muted-foreground">{timestamp}</span>
                <span className="text-[10px] text-muted-foreground">{hookCount} hook{hookCount !== 1 ? 's' : ''}</span>
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
            <InfoButton onInfo={onInfo} onInfoHover={onInfoHover} onInfoHoverEnd={onInfoHoverEnd} />
          </div>
          {isExpanded && (
            <div className="ml-10 space-y-1 border-t border-border bg-muted/20 p-2">
              {hookInfos.map((hook, i) => (
                <div key={i} className="rounded border border-border bg-background px-2 py-1">
                  <pre className="whitespace-pre-wrap break-all font-mono text-[10px] text-muted-foreground">{hook.command}</pre>
                </div>
              ))}
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
      );
    }

    if (subtype === 'hook_progress') {
      const hookName = (payload.hookName as string | undefined) ?? '';
      const hookEvent = (payload.hookEvent as string | undefined) ?? '';
      const command = (payload.command as string | undefined) ?? '';
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
                <span className="truncate font-mono text-[10px] text-muted-foreground">{hookName}</span>
                <span className="text-[10px] text-muted-foreground">{timestamp}</span>
              </div>
              {!isExpanded && (
                <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/70">{hookEvent}</p>
              )}
            </div>
            <InfoButton onInfo={onInfo} onInfoHover={onInfoHover} onInfoHoverEnd={onInfoHoverEnd} />
          </div>
          {isExpanded && (
            <div className="ml-10 border-t border-border bg-muted/20 p-2">
              <div className="space-y-1 text-[10px]">
                <div><span className="text-muted-foreground">Event: </span><span className="font-mono">{hookEvent}</span></div>
                <div><span className="text-muted-foreground">Hook: </span><span className="font-mono">{hookName}</span></div>
                <div>
                  <span className="text-muted-foreground">Command: </span>
                  <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[9px] text-muted-foreground">{command}</pre>
                </div>
              </div>
            </div>
          )}
        </div>
      );
    }

    if (subtype === 'agent_progress') {
      // Nested agent message — keep the rendering simple: dump as JSON inside an expandable card.
      // The nesting (data.message.message.content[]) is unusual enough that a generic block works.
      const agentId = (payload.agentId as string | undefined) ?? '';
      const prompt = (payload.prompt as string | undefined) ?? '';
      return (
        <div className={`border-b border-border ${indentWrapperClass}`}>
          <div
            role="button"
            tabIndex={0}
            onClick={onToggle}
            className={`flex w-full min-w-0 cursor-pointer items-start gap-2 p-2 text-left hover:bg-muted/30 ${indentInnerClass}`}
          >
            {isExpanded ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0" /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0" />}
            {childMarker}
            <Bot className="mt-0.5 h-4 w-4 shrink-0 text-cyan-500" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="rounded bg-cyan-500/10 px-1.5 py-0.5 text-[10px] text-cyan-600">agent</span>
                <span className="font-mono text-[10px] text-muted-foreground">{agentId.slice(0, 8)}</span>
                <span className="text-[10px] text-muted-foreground">{timestamp}</span>
              </div>
              {!isExpanded && prompt && (
                <p className="mt-0.5 line-clamp-2 break-all text-xs">{prompt}</p>
              )}
            </div>
            <InfoButton onInfo={onInfo} onInfoHover={onInfoHover} onInfoHoverEnd={onInfoHoverEnd} />
          </div>
          {isExpanded && (
            <div className="ml-10 space-y-2 border-t border-border bg-muted/20 p-2">
              {prompt && (
                <div className="rounded border border-cyan-500/20 bg-cyan-500/5 p-2">
                  <p className="text-[10px] font-medium text-cyan-600">Prompt:</p>
                  <p className="mt-1 whitespace-pre-wrap text-xs">{prompt}</p>
                </div>
              )}
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">
                {JSON.stringify(payload, null, 2)}
              </pre>
            </div>
          )}
        </div>
      );
    }

    // Generic system fallback
    return (
      <div className={indentWrapperClass}>
        <div className={`flex min-w-0 items-center gap-2 border-b border-border p-2 text-xs text-muted-foreground ${indentInnerClass}`}>
          {childMarker}
          <Activity className="h-3 w-3" />
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="min-w-0 break-all rounded bg-muted px-1.5 py-0.5">system</span>
            {subtype && <span className="rounded bg-muted px-1 text-[10px]">{subtype}</span>}
            <span className="shrink-0">{timestamp}</span>
          </div>
          <InfoButton onInfo={onInfo} onInfoHover={onInfoHover} onInfoHoverEnd={onInfoHoverEnd} className="ml-auto" />
        </div>
      </div>
    );
  }

  // ── Summary / meta / unknown — generic compact row ─────────────────────────
  return (
    <div className={indentWrapperClass}>
      <div className={`flex min-w-0 items-center gap-2 border-b border-border p-2 text-xs text-muted-foreground ${indentInnerClass}`}>
        {childMarker}
        <Activity className="h-3 w-3" />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="min-w-0 break-all rounded bg-muted px-1.5 py-0.5">{entry.role}</span>
          {entry.subtype && <span className="rounded bg-muted px-1 text-[10px]">{entry.subtype}</span>}
          {entry.summary && <span className="min-w-0 truncate text-[10px]">{entry.summary}</span>}
          <span className="shrink-0">{timestamp}</span>
        </div>
        <InfoButton onInfo={onInfo} onInfoHover={onInfoHover} onInfoHoverEnd={onInfoHoverEnd} className="ml-auto" />
      </div>
    </div>
  );
}

function InfoButton({
  onInfo,
  onInfoHover,
  onInfoHoverEnd,
  className,
}: {
  onInfo: () => void;
  onInfoHover: () => void;
  onInfoHoverEnd: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onInfo(); }}
      onMouseEnter={(e) => { e.stopPropagation(); onInfoHover(); }}
      onMouseLeave={(e) => { e.stopPropagation(); onInfoHoverEnd(); }}
      className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted ${className ?? ''}`}
      title="Entry details"
    >
      <Info className="h-3.5 w-3.5" />
    </button>
  );
}
