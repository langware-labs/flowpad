import {
  Activity,
  AlertTriangle,
  Bot,
  ChevronDown,
  ChevronRight,
  Info,
  Layers,
  Scissors,
  Square,
  Terminal,
  Timer,
  User,
  Zap,
} from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';

import { OperationExpandedDetail, OperationOneLiner } from './OperationRow';
import {
  formatDuration,
  formatEntryTime,
  formatNumber,
  operationFilterKey,
  thinkingPreview,
  workerIcon,
  workerLabel,
} from './transcript-utils';
import type { UnifiedEntry } from './types';

interface Props {
  entry: UnifiedEntry;
  isExpanded: boolean;
  onToggle: () => void;
  toolFilters?: Record<string, boolean>;
  onInfo: () => void;
  onInfoHover: () => void;
  onInfoHoverEnd: () => void;
}

export function TranscriptEntryItem({
  entry,
  isExpanded,
  onToggle,
  toolFilters,
  onInfo,
  onInfoHover,
  onInfoHoverEnd,
}: Props) {
  const timestamp = formatEntryTime(entry);
  // Sidechain entries get visual indent — same hierarchy hint as legacy.
  const isChild = !!entry.parentId || entry.isSidechain;
  const indentWrapperClass = isChild ? 'ms-4' : '';
  const indentInnerClass = isChild ? 'border-s-2 border-border/60 ps-3' : '';
  const childMarker = isChild ? (
    <span className="mt-0.5 text-xs text-muted-foreground/70" aria-hidden="true">
      ↳
    </span>
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
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onToggle();
            }
          }}
          className={`flex w-full min-w-0 cursor-pointer items-start gap-2 p-2 text-start hover:bg-muted/30 ${indentInnerClass}`}
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
              <span className="text-xs font-medium text-blue-600">
                <Trans>User</Trans>
              </span>
              <span className="text-[10px] text-muted-foreground">{timestamp}</span>
              {entry.isSidechain && (
                <span className="rounded bg-purple-500/10 px-1 text-[10px] text-purple-600">
                  <Trans>sidechain</Trans>
                </span>
              )}
              {hasToolResult && (
                <span
                  className={`rounded px-1 text-[10px] ${entry.toolResult!.isError ? 'bg-red-500/10 text-red-600' : 'bg-blue-500/10 text-blue-600'}`}
                >
                  {entry.toolResult!.isError ? <Trans>tool error</Trans> : <Trans>tool result</Trans>}
                </span>
              )}
            </div>
            <p
              className={`mt-0.5 break-all text-xs ${isExpanded ? '' : 'line-clamp-2'} ${entry.toolResult?.isError ? 'text-red-500' : ''}`}
            >
              {entry.text || (hasToolResult ? entry.toolResult!.output.slice(0, 200) : <Trans>(empty)</Trans>)}
            </p>
          </div>
          <InfoButton onInfo={onInfo} onInfoHover={onInfoHover} onInfoHoverEnd={onInfoHoverEnd} />
        </div>
        {isExpanded && hasToolResult && (
          <div className="ms-10 border-t border-border bg-muted/20 p-2">
            <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
              {entry.toolResult!.filePath && <span className="font-mono">{entry.toolResult!.filePath}</span>}
              {entry.toolResult!.durationMs != null && <span>{formatDuration(entry.toolResult!.durationMs)}</span>}
              {entry.toolResult!.exitCode != null && (
                <span>
                  <Trans>exit {entry.toolResult!.exitCode}</Trans>
                </span>
              )}
            </div>
            <pre
              className={`mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10px] ${entry.toolResult!.isError ? 'text-red-500' : 'text-muted-foreground'}`}
            >
              {entry.toolResult!.output}
            </pre>
          </div>
        )}
      </div>
    );
  }

  // ── Operation row (file_write / shell / search / web_fetch / tool_use catch-all) ──
  if (entry.role === 'operation' && entry.operation) {
    const op = entry.operation;
    // Filter chips key on the semantic kind (catch-all uses raw tool name).
    const filterKey = operationFilterKey(op);
    if (toolFilters && toolFilters[filterKey] === false) return null;
    return (
      <div className={`border-b border-border ${indentWrapperClass}`}>
        <div
          role="button"
          tabIndex={0}
          onClick={onToggle}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onToggle();
            }
          }}
          className={`flex w-full min-w-0 cursor-pointer items-start gap-2 p-2 text-start hover:bg-muted/30 ${indentInnerClass}`}
        >
          {isExpanded ? (
            <ChevronDown className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <ChevronRight className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          {childMarker}
          <OperationOneLiner operation={op} usage={entry.usage} />
          <span className="shrink-0 text-[10px] text-muted-foreground">{timestamp}</span>
          <InfoButton onInfo={onInfo} onInfoHover={onInfoHover} onInfoHoverEnd={onInfoHoverEnd} />
        </div>
        {isExpanded && (
          <div className="ms-10 border-t border-border bg-muted/20 p-2">
            <OperationExpandedDetail operation={op} />
          </div>
        )}
      </div>
    );
  }

  // ── Assistant text turn (+ optional usage) ─────────────────────────────────
  if (entry.role === 'assistant') {
    const totalTokens = (entry.usage?.input ?? 0) + (entry.usage?.output ?? 0);
    const WorkerIcon = workerIcon(entry.worker);
    return (
      <div className={`border-b border-border ${indentWrapperClass}`}>
        <div
          role="button"
          tabIndex={0}
          onClick={onToggle}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onToggle();
            }
          }}
          className={`flex w-full min-w-0 cursor-pointer items-start gap-2 p-2 text-start hover:bg-muted/30 ${indentInnerClass}`}
        >
          {isExpanded ? (
            <ChevronDown className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <ChevronRight className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          {childMarker}
          <WorkerIcon className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-foreground/80">{workerLabel(entry.worker)}</span>
              <span className="text-[10px] text-muted-foreground">{timestamp}</span>
              {entry.thinking && (
                <span className="shrink-0 rounded bg-purple-500/10 px-1 text-[10px] text-purple-600">
                  <Trans>thinking</Trans>
                </span>
              )}
              {entry.usage && totalTokens > 0 && (
                <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground">
                  <Zap className="h-2.5 w-2.5" />
                  {formatNumber(totalTokens)}
                </span>
              )}
            </div>
            <p
              className={`mt-0.5 break-all text-xs ${isExpanded ? '' : 'line-clamp-2'} ${!entry.text && entry.thinking ? 'italic text-purple-600/80' : ''}`}
            >
              {entry.text || thinkingPreview(entry.thinking) || <Trans>(no text content)</Trans>}
            </p>
          </div>
          <InfoButton onInfo={onInfo} onInfoHover={onInfoHover} onInfoHoverEnd={onInfoHoverEnd} />
        </div>

        {isExpanded && (
          <div className="ms-10 space-y-2 border-t border-border bg-muted/20 p-2">
            {entry.thinking && (
              <div className="rounded border border-purple-500/20 bg-purple-500/5 p-2">
                <p className="text-[10px] font-medium text-purple-600">
                  <Trans>Thinking:</Trans>
                </p>
                <p className="mt-1 whitespace-pre-wrap text-xs">{entry.thinking}</p>
              </div>
            )}

            {entry.usage && (
              <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground">
                <span>
                  <Trans>Input: {formatNumber(entry.usage.input ?? 0)}</Trans>
                </span>
                <span>
                  <Trans>Output: {formatNumber(entry.usage.output ?? 0)}</Trans>
                </span>
                {entry.usage.cacheRead != null && entry.usage.cacheRead > 0 && (
                  <span className="text-green-600">
                    <Trans>Cache read: {formatNumber(entry.usage.cacheRead)}</Trans>
                  </span>
                )}
                {entry.usage.cacheCreation != null && entry.usage.cacheCreation > 0 && (
                  <span className="text-orange-600">
                    <Trans>Cache write: {formatNumber(entry.usage.cacheCreation)}</Trans>
                  </span>
                )}
                {entry.usage.costUsd != null && entry.usage.costUsd > 0 && (
                  <span className="font-medium text-foreground" data-testid="turn-cost-usd">
                    ${entry.usage.costUsd < 0.01 ? entry.usage.costUsd.toFixed(4) : entry.usage.costUsd.toFixed(3)}
                  </span>
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
            className={`flex w-full min-w-0 items-start gap-2 p-2 text-start hover:bg-muted/30 ${indentInnerClass}`}
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
                  <Trans>bash progress</Trans>
                </span>
                <span className="text-[10px] text-muted-foreground">{timestamp}</span>
                <span className="text-[10px] text-muted-foreground">{elapsed}s</span>
              </div>
              <p className={`mt-0.5 break-all font-mono text-[10px] ${isExpanded ? '' : 'line-clamp-2'}`}>
                {output || <Trans>(running...)</Trans>}
              </p>
            </div>
          </button>
          {isExpanded && fullOutput && (
            <div className="ms-10 border-t border-border bg-muted/20 p-2">
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
          <div
            className={`flex min-w-0 items-center gap-2 border-b border-border p-2 text-xs text-muted-foreground ${indentInnerClass}`}
          >
            {childMarker}
            <Timer className="h-3 w-3 text-blue-400" />
            <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-600">
              <Trans>turn duration</Trans>
            </span>
            <span className="font-medium text-foreground">{formatDuration(durationMs)}</span>
            <span className="shrink-0">{timestamp}</span>
            <InfoButton onInfo={onInfo} onInfoHover={onInfoHover} onInfoHoverEnd={onInfoHoverEnd} className="ms-auto" />
          </div>
        </div>
      );
    }

    if (subtype === 'compact_boundary') {
      return (
        <div className={indentWrapperClass}>
          <div
            className={`flex min-w-0 items-center gap-2 border-b border-border p-2 text-xs text-muted-foreground ${indentInnerClass}`}
          >
            {childMarker}
            <Scissors className="h-3 w-3 text-purple-400" />
            <span className="rounded bg-purple-500/10 px-1.5 py-0.5 text-[10px] text-purple-600">
              <Trans>compact boundary</Trans>
            </span>
            <span className="shrink-0">{timestamp}</span>
            <InfoButton onInfo={onInfo} onInfoHover={onInfoHover} onInfoHoverEnd={onInfoHoverEnd} className="ms-auto" />
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
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onToggle();
              }
            }}
            className={`flex w-full min-w-0 cursor-pointer items-start gap-2 p-2 text-start hover:bg-muted/30 ${indentInnerClass}`}
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
                  <Trans>stop hooks</Trans>
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
                  <span className="rounded bg-red-500/10 px-1 text-[10px] text-red-600">
                    <Trans>blocked</Trans>
                  </span>
                )}
                {stopReason && <span className="truncate text-[10px] text-muted-foreground">{stopReason}</span>}
              </div>
            </div>
            <InfoButton onInfo={onInfo} onInfoHover={onInfoHover} onInfoHoverEnd={onInfoHoverEnd} />
          </div>
          {isExpanded && (
            <div className="ms-10 space-y-1 border-t border-border bg-muted/20 p-2">
              {hookInfos.map((hook, i) => (
                <div key={i} className="rounded border border-border bg-background px-2 py-1">
                  <pre className="whitespace-pre-wrap break-all font-mono text-[10px] text-muted-foreground">
                    {hook.command}
                  </pre>
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
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onToggle();
              }
            }}
            className={`flex w-full min-w-0 cursor-pointer items-start gap-2 p-2 text-start hover:bg-muted/30 ${indentInnerClass}`}
          >
            {isExpanded ? (
              <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            <Zap className="mt-0.5 h-4 w-4 shrink-0 text-purple-400" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="rounded bg-purple-500/10 px-1.5 py-0.5 text-[10px] text-purple-500">
                  <Trans>hook</Trans>
                </span>
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
            <div className="ms-10 border-t border-border bg-muted/20 p-2">
              <div className="space-y-1 text-[10px]">
                <div>
                  <span className="text-muted-foreground">
                    <Trans>Event: </Trans>
                  </span>
                  <span className="font-mono">{hookEvent}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">
                    <Trans>Hook: </Trans>
                  </span>
                  <span className="font-mono">{hookName}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">
                    <Trans>Command: </Trans>
                  </span>
                  <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[9px] text-muted-foreground">
                    {command}
                  </pre>
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
            className={`flex w-full min-w-0 cursor-pointer items-start gap-2 p-2 text-start hover:bg-muted/30 ${indentInnerClass}`}
          >
            {isExpanded ? (
              <ChevronDown className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <ChevronRight className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            {childMarker}
            <Bot className="mt-0.5 h-4 w-4 shrink-0 text-cyan-500" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="rounded bg-cyan-500/10 px-1.5 py-0.5 text-[10px] text-cyan-600">
                  <Trans>agent</Trans>
                </span>
                <span className="font-mono text-[10px] text-muted-foreground">{agentId.slice(0, 8)}</span>
                <span className="text-[10px] text-muted-foreground">{timestamp}</span>
              </div>
              {!isExpanded && prompt && <p className="mt-0.5 line-clamp-2 break-all text-xs">{prompt}</p>}
            </div>
            <InfoButton onInfo={onInfo} onInfoHover={onInfoHover} onInfoHoverEnd={onInfoHoverEnd} />
          </div>
          {isExpanded && (
            <div className="ms-10 space-y-2 border-t border-border bg-muted/20 p-2">
              {prompt && (
                <div className="rounded border border-cyan-500/20 bg-cyan-500/5 p-2">
                  <p className="text-[10px] font-medium text-cyan-600">
                    <Trans>Prompt:</Trans>
                  </p>
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
        <div
          className={`flex min-w-0 items-center gap-2 border-b border-border p-2 text-xs text-muted-foreground ${indentInnerClass}`}
        >
          {childMarker}
          <Activity className="h-3 w-3" />
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="min-w-0 break-all rounded bg-muted px-1.5 py-0.5">
              <Trans>system</Trans>
            </span>
            {subtype && <span className="rounded bg-muted px-1 text-[10px]">{subtype}</span>}
            <span className="shrink-0">{timestamp}</span>
          </div>
          <InfoButton onInfo={onInfo} onInfoHover={onInfoHover} onInfoHoverEnd={onInfoHoverEnd} className="ms-auto" />
        </div>
      </div>
    );
  }

  // ── Workflow phase — full-width section divider grouping the agents below it ──
  if (entry.role === 'meta' && entry.subtype === 'workflow_phase') {
    const phaseIndex = entry.payload?.index as number | undefined;
    const phaseTitle = (entry.payload?.title as string | undefined) ?? '';
    return (
      <div className="flex min-w-0 items-center gap-2 border-t border-border bg-muted/40 p-2 text-xs">
        <Layers className="h-3.5 w-3.5 shrink-0 text-indigo-500" />
        <span className="font-medium text-foreground">
          {phaseIndex != null ? `Phase ${phaseIndex}` : 'Phase'}
          {phaseTitle ? ` · ${phaseTitle}` : ''}
        </span>
        <span className="ms-auto shrink-0 text-[10px] text-muted-foreground">{timestamp}</span>
        <InfoButton onInfo={onInfo} onInfoHover={onInfoHover} onInfoHoverEnd={onInfoHoverEnd} />
      </div>
    );
  }

  // ── Summary / meta / unknown — generic compact row ─────────────────────────
  return (
    <div className={indentWrapperClass}>
      <div
        className={`flex min-w-0 items-center gap-2 border-b border-border p-2 text-xs text-muted-foreground ${indentInnerClass}`}
      >
        {childMarker}
        <Activity className="h-3 w-3" />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="min-w-0 break-all rounded bg-muted px-1.5 py-0.5">{entry.role}</span>
          {entry.subtype && <span className="rounded bg-muted px-1 text-[10px]">{entry.subtype}</span>}
          {entry.summary && <span className="min-w-0 truncate text-[10px]">{entry.summary}</span>}
          <span className="shrink-0">{timestamp}</span>
        </div>
        <InfoButton onInfo={onInfo} onInfoHover={onInfoHover} onInfoHoverEnd={onInfoHoverEnd} className="ms-auto" />
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
  const { t } = useLingui();
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onInfo();
      }}
      onMouseEnter={(e) => {
        e.stopPropagation();
        onInfoHover();
      }}
      onMouseLeave={(e) => {
        e.stopPropagation();
        onInfoHoverEnd();
      }}
      className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted ${className ?? ''}`}
      title={t`Entry details`}
    >
      <Info className="h-3.5 w-3.5" />
    </button>
  );
}
