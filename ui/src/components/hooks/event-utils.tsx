import { LAYER_COLORS } from '@src/hooks/sniffer-layers';
import type { EventLayer } from '@src/hooks/use-hooks-sniffer';
import type { TraceEvent } from '@src/types/trace-event';
import { FlowDataSource } from '@sdk';
import { cn } from '@src/lib/utils';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  AlertTriangle,
  Bell,
  CircleCheck,
  CircleX,
  Clock,
  DatabaseZap,
  FlagTriangleRight,
  FolderGit2,
  FolderX,
  GitBranch,
  GitFork,
  ListChecks,
  ListPlus,
  Map,
  MessageSquare,
  Microscope,
  Minimize2,
  OctagonX,
  Play,
  Settings,
  ShieldAlert,
  Sparkles,
  Square,
  Wrench,
  Zap,
} from 'lucide-react';
import { useCopied } from '@src/components/ui/copy-button';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The renderer-facing contract these helpers actually consume. TWO producers
 * feed them: `TraceEvent` (the per-process FlowData stream, InteractiveTerminal
 * gutter) and `SnifferEvent` (`use-hooks-sniffer`, the hook panels/chip). Both
 * satisfy this shape; a field only one of them carries is optional here.
 */
export type RenderableEvent = {
  id: string;
  timestamp: string;
  event_type: string;
  session_id?: string;
  source?: FlowDataSource;
  element_type?: string;
  summary?: string;
  tool_name?: string;
  tool_input?: Record<string, any>;
  raw?: Record<string, any>;
  attributes?: Record<string, string>;
  webhook_type?: string;
  hook_data?: Record<string, any>;
  layer?: EventLayer;
  warning?: string;
  error?: string;
  transcriptDockPointer: { ref: string; options: Record<string, string> } | null;
};

export const EVENT_ICONS: Record<string, LucideIcon> = {
  SessionStart: Play,
  SessionEnd: Square,
  UserPromptSubmit: MessageSquare,
  PreToolUse: Wrench,
  PostToolUse: CircleCheck,
  PostToolUseFailure: CircleX,
  Notification: Bell,
  Stop: OctagonX,
  SubagentStart: GitFork,
  SubagentStop: GitBranch,
  PreCompact: Minimize2,
  PermissionRequest: ShieldAlert,
  TeammateIdle: Clock,
  TaskCreated: ListPlus,
  TaskCompleted: ListChecks,
  ConfigChange: Settings,
  WorktreeCreate: FolderGit2,
  WorktreeRemove: FolderX,
  TaskStart: FlagTriangleRight,
  AgentComplete: CircleCheck,
  PlanReady: Map,
  SkillUsed: Sparkles,
};

/** Icons for hook_op events, keyed by event_name or operation */
export const HOOK_OP_ICONS: Record<string, LucideIcon> = {
  rules_executed: Microscope,
};

export function getEventIcon(eventType: string, event?: RenderableEvent): LucideIcon {
  if (event?.error || event?.element_type === 'error') return CircleX;
  if (event?.warning) return AlertTriangle;
  if (event?.webhook_type === 'hook_op') {
    // Read the hook-op discriminator from canonical attributes (set by
    // convert_hook_op_event); fall back to the legacy hook_data shape only
    // for events that haven't been routed through the dispatcher yet.
    const eventName = event.attributes?.['hook-op-event-name'] ?? event.hook_data?.event_name;
    if (eventName && HOOK_OP_ICONS[eventName]) return HOOK_OP_ICONS[eventName];
    const operation = event.attributes?.['hook-op-operation'] ?? event.hook_data?.operation;
    if (operation === 'event') return Zap;
    return DatabaseZap;
  }
  if (eventType === 'UserMessage') return MessageSquare;
  if (eventType === 'AssistantMessage') return Sparkles;
  if (eventType.startsWith('System:')) return Clock;
  if (eventType.startsWith('SkillUsed:')) return Sparkles;
  return EVENT_ICONS[eventType] ?? Activity;
}

export const WEBHOOK_TYPE_COLORS: Record<string, string> = {
  agent_hook: 'text-blue-500',
  hook_op: 'text-green-500',
  transcript_entry: 'text-emerald-500',
};

/** Colors for specific hook_op event_name values */
export const HOOK_OP_COLORS: Record<string, string> = {
  rules_executed: 'text-amber-400',
};

/** Per event-type colors — used by getEventColor as the primary color source */
export const EVENT_TYPE_COLORS: Record<string, string> = {
  SessionStart: 'text-green-500',
  SessionEnd: 'text-red-400',
  UserPromptSubmit: 'text-blue-400',
  PreToolUse: 'text-sky-400',
  PostToolUse: 'text-green-400',
  PostToolUseFailure: 'text-red-500',
  Notification: 'text-amber-400',
  Stop: 'text-red-500',
  SubagentStart: 'text-cyan-400',
  SubagentStop: 'text-orange-400',
  PreCompact: 'text-slate-400',
  PermissionRequest: 'text-amber-500',
  TeammateIdle: 'text-slate-400',
  TaskCreated: 'text-blue-400',
  TaskCompleted: 'text-green-500',
  ConfigChange: 'text-blue-400',
  WorktreeCreate: 'text-teal-500',
  WorktreeRemove: 'text-red-400',
  TaskStart: 'text-teal-500',
  AgentComplete: 'text-green-500',
  PlanReady: 'text-blue-500',
  SkillUsed: 'text-purple-500',
  UserMessage: 'text-blue-400',
  AssistantMessage: 'text-emerald-400',
  error: 'text-red-500',
  session_detect_failed: 'text-red-500',
};

export function getWebhookColor(webhookType?: string): string {
  return WEBHOOK_TYPE_COLORS[webhookType ?? ''] ?? 'text-primary';
}

export function getEventColor(event: RenderableEvent): string {
  if (event.error || event.element_type === 'error') return 'text-red-500';
  if (event.warning) return 'text-yellow-500';
  if (event.event_type.startsWith('SkillUsed:')) return 'text-purple-600';
  // hook_op: per-operation color first, then webhook fallback. Read the
  // discriminator from canonical attributes; legacy hook_data is fallback.
  if (event.webhook_type === 'hook_op') {
    const eventName = event.attributes?.['hook-op-event-name'] ?? event.hook_data?.event_name;
    if (eventName && HOOK_OP_COLORS[eventName]) return HOOK_OP_COLORS[eventName];
    return WEBHOOK_TYPE_COLORS['hook_op'];
  }
  // per-type color takes priority over generic source/layer colors
  const typeColor = EVENT_TYPE_COLORS[event.event_type];
  if (typeColor) return typeColor;
  if (event.source === FlowDataSource.History) return 'text-emerald-500';
  if (event.layer && event.layer !== 'debug') return LAYER_COLORS[event.layer];
  return getWebhookColor(event.webhook_type);
}

// ---------------------------------------------------------------------------
// isPlanWrite – detect tool writes into plans/*.md (cross-platform)
// ---------------------------------------------------------------------------

export function isPlanWrite(event: RenderableEvent): boolean {
  const toolName = event.hook_data?.tool_name;
  if (toolName !== 'Write') return false;
  const filePath: string = event.hook_data?.tool_input?.file_path || '';
  if (!filePath) return false;
  // Normalize separators for cross-platform support (handles both / and \)
  const normalized = filePath.replace(/\\/g, '/');
  return /\/plans\/[^/]+\.md$/.test(normalized);
}

// ---------------------------------------------------------------------------
// getOneLiner – extract a short summary from a trace event
// ---------------------------------------------------------------------------

export function cropText(text: string, maxWords = 5): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(' ');
  return words.slice(0, maxWords).join(' ') + '...';
}

export function getOneLiner(event: RenderableEvent): string {
  // 1. Top-level tool name (set by mapFlowDataToTraceEvent for tool-call /
  //    tool-result events, by the legacy mapTranscriptToTraceEvents for
  //    transcript-source events).
  if (event.tool_name) {
    return cropText(event.tool_name);
  }
  if (event.tool_input) {
    const candidate = event.tool_input.command || event.tool_input.file_path || event.tool_input.pattern || '';
    if (candidate) return cropText(typeof candidate === 'string' ? candidate : JSON.stringify(candidate));
  }
  if (event.summary) return cropText(event.summary);
  if (event.error) return cropText(event.error, 8);
  if (typeof event.raw?.value === 'string' && event.raw.value) return cropText(event.raw.value, 8);

  // 2. Canonical FlowData attributes set by hook_to_flowdata.convert_hook_event:
  //    these flatten Claude raw_hook_data fields onto the wire so the renderer
  //    doesn't need to dig through hook_data.raw_hook_data.* itself.
  const attrs = event.attributes;
  if (attrs) {
    const fromAttrs =
      attrs['hook-message'] ||
      attrs['tool-input-summary'] ||
      attrs['hook-error'] ||
      attrs['hook-stop-reason'] ||
      attrs['hook-task-subject'] ||
      attrs['hook-agent-type'] ||
      attrs['hook-teammate-name'] ||
      attrs['hook-source'] ||
      attrs['hook-name'] ||
      attrs['hook-worktree-path'] ||
      '';
    if (fromAttrs) return cropText(fromAttrs);
  }

  // 3. Legacy fallback for events that haven't been routed through the
  //    dispatcher yet (e.g., direct sniffer-hook subscribers that still
  //    receive `mapSnifferToTraceEvent`-shape via hook_data).
  const hookData = event.hook_data;
  if (!hookData) return '';
  const raw = hookData.raw_hook_data as Record<string, unknown> | undefined;
  if (raw) {
    for (const key of Object.keys(raw)) {
      if ((key === 'message' || key === 'prompt' || key.includes('message')) && typeof raw[key] === 'string' && raw[key]) {
        return cropText(raw[key] as string);
      }
    }
  }
  const candidate =
    hookData.tool_name ||
    hookData.tool_input?.command ||
    hookData.tool_input?.pattern ||
    hookData.tool_input?.file_path ||
    hookData.tool_input?.query ||
    hookData.tool_input?.url ||
    hookData.tool_input?.code ||
    hookData.tool_input?.prompt ||
    raw?.error ||
    raw?.stop_reason ||
    raw?.task_subject ||
    raw?.agent_type ||
    raw?.teammate_name ||
    raw?.source ||
    raw?.name ||
    raw?.worktree_path ||
    '';
  const text = typeof candidate === 'string' ? candidate : JSON.stringify(candidate);
  return cropText(text);
}

// ---------------------------------------------------------------------------
// getTranscriptLensPointer – compute lens ref + options for a trace event
// ---------------------------------------------------------------------------

/**
 * Compute the transcript lens pointer for a TraceEvent.
 *
 * - Sniffer events: returns the pre-computed transcriptDockPointer (includes SessionStart guard).
 * - Transcript-source events: built from the event's session_id; the lens
 *   resolves the JSONL path server-side via ClaudeSessionRecord.discover.
 *
 * Returns null when not enough information is available.
 */
export function getTranscriptLensPointer(
  event: TraceEvent,
): { ref: string; options: Record<string, string> } | null {
  // Sniffer events: pre-computed at parse time (SessionStart already filtered out)
  if (event.source === FlowDataSource.Sniffer) return event.transcriptDockPointer;

  if (event.source === FlowDataSource.History && event.session_id) {
    const options: Record<string, string> = {};
    const match = event.id.match(/^transcript-([0-9a-f-]{36})(?:-tool-\d+)?$/);
    if (match) options.transcript_entry_id = match[1];
    else if (event.timestamp) options.ts = event.timestamp;
    return { ref: event.session_id, options };
  }

  return null;
}

// ---------------------------------------------------------------------------
// navigateToTranscript – open transcript lens for a trace event
// ---------------------------------------------------------------------------

export function navigateToTranscript(
  event: { transcriptDockPointer: { ref: string; options: Record<string, string> } | null },
  navigation: ReturnType<typeof useDockNavigation>['navigation'],
) {
  const pointer = event.transcriptDockPointer;
  if (!pointer) return;
  navigation.openLens('claude', 'transcript', pointer.ref, pointer.options);
}

// ---------------------------------------------------------------------------
// EventTooltipContent – shared tooltip body for trace events
// ---------------------------------------------------------------------------

export function EventTooltipContent({ event }: { event: RenderableEvent }) {
  const Icon = getEventIcon(event.event_type, event);
  const { copied, copy } = useCopied();

  // Read sniffer-only details from canonical FlowData attributes; fall back
  // to the legacy hook_data path for events that haven't been dispatched
  // through `convert_hook_event` yet.
  const entryId =
    event.attributes?.['hook-entry-id'] ?? (event.hook_data as any)?.hook_entry_id;
  const filePath =
    event.attributes?.['hook-file-path'] ?? (event.hook_data as any)?.hook_file_path;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Icon className={cn('h-3.5 w-3.5 shrink-0', getEventColor(event))} />
        <span className="font-semibold text-popover-foreground">{event.event_type}</span>
      </div>
      {event.warning && <div className="text-xs font-medium text-yellow-500">Warning: {event.warning}</div>}
      <div className="text-xs text-popover-foreground/60">{new Date(event.timestamp).toLocaleString()}</div>
      {event.source === FlowDataSource.Sniffer && entryId && (
        <div className="truncate text-xs text-popover-foreground/60">Entry: {entryId}</div>
      )}
      {event.source === FlowDataSource.Sniffer && filePath && (
        <div className="truncate text-xs text-popover-foreground/60">Source: {filePath}</div>
      )}
      {event.session_id && <div className="truncate text-xs text-popover-foreground/60">Session: {event.session_id}</div>}
      <div className="relative mt-1">
        <button
          onClick={() => void copy(JSON.stringify(event.raw, null, 2))}
          className="absolute right-1 top-1 rounded bg-popover-foreground/10 px-1.5 py-0.5 text-[9px] text-popover-foreground/60 opacity-0 transition-opacity hover:text-popover-foreground [div:hover>&]:opacity-100"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <pre className="whitespace-pre-wrap break-all rounded-md border border-border bg-popover-foreground/5 p-1.5 text-[10px] leading-tight text-popover-foreground/70">
          {JSON.stringify(event.raw, null, 2)}
        </pre>
      </div>
    </div>
  );
}
