import { LAYER_COLORS } from '@src/hooks/sniffer-layers';
import type { ClaudeTraceEvent } from '@src/types/trace-event';
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
import { useCallback, useState } from 'react';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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
  workflow_trace: ListChecks,
};

export function getEventIcon(eventType: string, event?: ClaudeTraceEvent): LucideIcon {
  if (event?.warning) return AlertTriangle;
  if (event?.webhook_type === 'hook_op') {
    const eventName = event.hook_data?.event_name;
    if (eventName && HOOK_OP_ICONS[eventName]) return HOOK_OP_ICONS[eventName];
    if (event.hook_data?.operation === 'event') return Zap;
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
  workflow_trace: 'text-teal-400',
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
};

export function getWebhookColor(webhookType?: string): string {
  return WEBHOOK_TYPE_COLORS[webhookType ?? ''] ?? 'text-primary';
}

export function getEventColor(event: ClaudeTraceEvent): string {
  if (event.warning) return 'text-yellow-500';
  if (event.event_type.startsWith('SkillUsed:')) return 'text-purple-600';
  // hook_op: per-operation color first, then webhook fallback
  if (event.webhook_type === 'hook_op') {
    const eventName = event.hook_data?.event_name;
    if (eventName && HOOK_OP_COLORS[eventName]) return HOOK_OP_COLORS[eventName];
    return WEBHOOK_TYPE_COLORS['hook_op'];
  }
  // per-type color takes priority over generic source/layer colors
  const typeColor = EVENT_TYPE_COLORS[event.event_type];
  if (typeColor) return typeColor;
  if (event.source === 'transcript') return 'text-emerald-500';
  if (event.layer && event.layer !== 'debug') return LAYER_COLORS[event.layer];
  return getWebhookColor(event.webhook_type);
}

// ---------------------------------------------------------------------------
// isPlanWrite – detect tool writes into plans/*.md (cross-platform)
// ---------------------------------------------------------------------------

export function isPlanWrite(event: ClaudeTraceEvent): boolean {
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

export function getOneLiner(event: ClaudeTraceEvent): string {
  // Transcript events: check top-level tool_name/tool_input first
  if (event.tool_name) {
    return cropText(event.tool_name);
  }
  if (event.tool_input) {
    const candidate = event.tool_input.command || event.tool_input.file_path || event.tool_input.pattern || '';
    if (candidate) return cropText(typeof candidate === 'string' ? candidate : JSON.stringify(candidate));
  }
  if (event.summary) return cropText(event.summary);

  // Fall back to hook_data path (sniffer events)
  const hookData = event.hook_data;
  if (!hookData) return '';

  // Prefer message/prompt fields from raw_hook_data (e.g. message, prompt, last_assistant_message)
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
 * Compute the transcript lens pointer for a ClaudeTraceEvent.
 *
 * - Sniffer events: returns the pre-computed transcriptDockPointer (includes SessionStart guard).
 * - Transcript-source events: computes on-the-fly using the projectEncodedName from context,
 *   since transcript entries don't carry a transcript_path.
 *
 * Returns null when not enough information is available.
 */
export function getTranscriptLensPointer(
  event: ClaudeTraceEvent,
  projectEncodedName?: string,
): { ref: string; options: Record<string, string> } | null {
  // Sniffer events: pre-computed at parse time (SessionStart already filtered out)
  if (event.source === 'sniffer') return event.transcriptDockPointer;

  // Transcript-source events need projectEncodedName from the viewer's context
  if (event.source === 'transcript' && projectEncodedName && event.session_id) {
    const options: Record<string, string> = {};
    const match = event.id.match(/^transcript-([0-9a-f-]{36})(?:-tool-\d+)?$/);
    if (match) options.transcript_entry_id = match[1];
    else if (event.timestamp) options.ts = event.timestamp;
    return { ref: `${projectEncodedName}/${event.session_id}`, options };
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

export function EventTooltipContent({ event }: { event: ClaudeTraceEvent }) {
  const Icon = getEventIcon(event.event_type, event);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(JSON.stringify(event.raw, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [event.raw]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Icon className={cn('h-3.5 w-3.5 shrink-0', getEventColor(event))} />
        <span className="font-semibold text-popover-foreground">{event.event_type}</span>
      </div>
      {event.warning && <div className="text-xs font-medium text-yellow-500">Warning: {event.warning}</div>}
      <div className="text-xs text-popover-foreground/60">{new Date(event.timestamp).toLocaleString()}</div>
      {event.source === 'sniffer' && (event.hook_data as any)?.hook_entry_id && (
        <div className="truncate text-xs text-popover-foreground/60">Entry: {(event.hook_data as any).hook_entry_id}</div>
      )}
      {event.source === 'sniffer' && (event.hook_data as any)?.hook_file_path && (
        <div className="truncate text-xs text-popover-foreground/60">Source: {(event.hook_data as any).hook_file_path}</div>
      )}
      {event.session_id && <div className="truncate text-xs text-popover-foreground/60">Session: {event.session_id}</div>}
      <div className="relative mt-1">
        <button
          onClick={handleCopy}
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
