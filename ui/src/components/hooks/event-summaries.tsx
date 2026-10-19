import type { SnifferEvent } from '@src/hooks/use-hooks-sniffer';
import { Badge } from '@src/components/ui/badge';
import { cn } from '@src/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { isPlanWrite } from './event-utils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortenPath(filePath: string): string {
  if (!filePath) return '';
  const parts = filePath.split('/').filter(Boolean);
  if (parts.length <= 2) return filePath;
  return '\u2026/' + parts[parts.length - 1];
}

export function truncate(text: string, max: number): string {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '\u2026' : text;
}

// ---------------------------------------------------------------------------
// Shared props for all sub-component renderers
// ---------------------------------------------------------------------------

export interface EventPartProps {
  event: SnifferEvent;
}

// ---------------------------------------------------------------------------
// EventSummaryConfig — extensible per-event-type sub-component registry
//
// Each event type (tool name or hook event name) can register sub-components
// for different rendering slots. Add new slots here as the UI evolves.
// ---------------------------------------------------------------------------

export interface EventSummaryConfig {
  /** Inline summary shown in the event row */
  oneLiner?: React.FC<EventPartProps>;
  // Future sub-component slots:
  // details?: React.FC<EventPartProps>;
  // actions?: React.FC<EventPartProps>;
  // header?: React.FC<EventPartProps>;
}

// ---------------------------------------------------------------------------
// ToolNameChips — renders tool name as badge(s)
//
// MCP tools (mcp__{server}__{function}) split into 3 chips.
// Regular tools render as a single chip.
// ---------------------------------------------------------------------------

function parseMcpToolName(toolName: string): { server: string; fn: string } | null {
  if (!toolName.startsWith('mcp__')) return null;
  const parts = toolName.split('__');
  if (parts.length < 3) return null;
  return { server: parts[1], fn: parts.slice(2).join('__') };
}

export const CHIP = 'me-1 shrink-0 text-[10px]';

function ToolNameChips({ toolName }: { toolName: string }) {
  const mcp = parseMcpToolName(toolName);
  if (mcp) {
    return (
      <>
        <Badge variant="outline" className={`${CHIP} opacity-50`}>
          mcp
        </Badge>
        <Badge variant="outline" className={CHIP}>
          {mcp.server}
        </Badge>
        <Badge variant="outline" className={CHIP}>
          {mcp.fn}
        </Badge>
      </>
    );
  }
  return (
    <Badge variant="outline" className={CHIP}>
      {toolName}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Tool one-liner sub-components (keyed by tool_name)
// ---------------------------------------------------------------------------

function TodoWriteOneLiner({ event }: EventPartProps) {
  const todos: any[] = event.hook_data?.tool_input?.todos;
  if (!Array.isArray(todos) || todos.length === 0) return null;

  const completed = todos.filter((t: any) => t.status === 'completed').length;
  const inProgress = todos.filter((t: any) => t.status === 'in_progress').length;
  const pending = todos.filter((t: any) => t.status === 'pending').length;

  const lastCompleted = [...todos].reverse().find((t: any) => t.status === 'completed');
  const activeTask = todos.find((t: any) => t.status === 'in_progress');

  const completedLabel = lastCompleted?.content || '';
  const activeLabel = activeTask?.activeForm || activeTask?.content || '';

  return (
    <>
      <span className="text-green-500">{completed}&#10003;</span>{' '}
      <span className="text-blue-400">{inProgress}&#8594;</span> <span className="opacity-60">{pending}&#9675;</span>
      {completedLabel && <span className="text-green-400/70"> {truncate(completedLabel, 25)}</span>}
      {activeLabel && <span className="text-blue-300/80"> | {truncate(activeLabel, 30)}</span>}
    </>
  );
}

function ReadOneLiner({ event }: EventPartProps) {
  const path = event.hook_data?.tool_input?.file_path || '';
  return <>{path ? shortenPath(path) : null}</>;
}

function WriteOneLiner({ event }: EventPartProps) {
  const path = event.hook_data?.tool_input?.file_path || '';
  return <>{path ? shortenPath(path) : null}</>;
}

function EditOneLiner({ event }: EventPartProps) {
  const path = event.hook_data?.tool_input?.file_path || '';
  return <>{path ? shortenPath(path) : null}</>;
}

function BashOneLiner({ event }: EventPartProps) {
  const desc = event.hook_data?.tool_input?.description;
  if (desc) return <>{truncate(desc, 60)}</>;
  const cmd = event.hook_data?.tool_input?.command || '';
  return <>{cmd ? truncate(cmd, 60) : null}</>;
}

function GrepOneLiner({ event }: EventPartProps) {
  const pattern = event.hook_data?.tool_input?.pattern || '';
  const path = event.hook_data?.tool_input?.path || '';
  const glob = event.hook_data?.tool_input?.glob || '';
  if (!pattern && !path) return null;
  return (
    <>
      {pattern && <span>{truncate(pattern, 30)}</span>}
      {path && <span className="opacity-60"> {shortenPath(path)}</span>}
      {glob && <span className="opacity-60"> {glob}</span>}
    </>
  );
}

function GlobOneLiner({ event }: EventPartProps) {
  const pattern = event.hook_data?.tool_input?.pattern || '';
  const path = event.hook_data?.tool_input?.path || '';
  if (!pattern && !path) return null;
  return (
    <>
      {pattern && <span>{truncate(pattern, 40)}</span>}
      {path && <span className="opacity-60"> {shortenPath(path)}</span>}
    </>
  );
}

function TaskOneLiner({ event }: EventPartProps) {
  const desc = event.hook_data?.tool_input?.description || event.hook_data?.tool_input?.prompt || '';
  return <>{desc ? truncate(desc, 60) : null}</>;
}

function WebFetchOneLiner({ event }: EventPartProps) {
  const url = event.hook_data?.tool_input?.url || '';
  return <>{url ? truncate(url, 60) : null}</>;
}

function WebSearchOneLiner({ event }: EventPartProps) {
  const query = event.hook_data?.tool_input?.query || '';
  return <>{query ? truncate(query, 60) : null}</>;
}

function SkillOneLiner({ event }: EventPartProps) {
  const skill = event.hook_data?.tool_input?.skill || '';
  const args = event.hook_data?.tool_input?.args || '';
  if (!skill) return null;
  return (
    <>
      <Badge variant="outline" className={CHIP}>
        {skill}
      </Badge>
      {args && (
        <Badge variant="outline" className={`${CHIP} opacity-60`}>
          {truncate(args, 40)}
        </Badge>
      )}
    </>
  );
}

function SubagentStopOneLiner({ event }: EventPartProps) {
  const agentType = event.hook_data?.raw_hook_data?.agent_type || '';
  if (!agentType) return null;
  return (
    <Badge variant="outline" className={CHIP}>
      {agentType}
    </Badge>
  );
}

function SubagentStartOneLiner({ event }: EventPartProps) {
  const agentType = event.hook_data?.raw_hook_data?.agent_type || '';
  if (!agentType) return null;
  return (
    <Badge variant="outline" className={CHIP}>
      {agentType}
    </Badge>
  );
}

function PostToolUseFailureOneLiner({ event }: EventPartProps) {
  const toolName = event.hook_data?.tool_name || '';
  const error = event.hook_data?.raw_hook_data?.error || '';
  const isInterrupt = event.hook_data?.raw_hook_data?.is_interrupt;
  return (
    <>
      {toolName && (
        <Badge variant="outline" className={`${CHIP} border-red-500/50 text-red-500`}>
          {toolName}
        </Badge>
      )}
      {isInterrupt && (
        <Badge variant="outline" className={`${CHIP} border-yellow-500/50 text-yellow-500`}>
          interrupted
        </Badge>
      )}
      {error && <span className="text-red-400/80">{truncate(error, 60)}</span>}
    </>
  );
}

function TeammateIdleOneLiner({ event }: EventPartProps) {
  const teammateName = event.hook_data?.raw_hook_data?.teammate_name || '';
  const teamName = event.hook_data?.raw_hook_data?.team_name || '';
  return (
    <>
      {teammateName && (
        <Badge variant="outline" className={CHIP}>
          {teammateName}
        </Badge>
      )}
      {teamName && <span className="opacity-60">{teamName}</span>}
    </>
  );
}

function TaskCreatedOneLiner({ event }: EventPartProps) {
  const taskSubject = event.hook_data?.raw_hook_data?.task_subject || '';
  const teammateName = event.hook_data?.raw_hook_data?.teammate_name || '';
  return (
    <>
      {teammateName && (
        <Badge variant="outline" className={`${CHIP} opacity-60`}>
          {teammateName}
        </Badge>
      )}
      {taskSubject && <span>{truncate(taskSubject, 50)}</span>}
    </>
  );
}

function TaskCompletedOneLiner({ event }: EventPartProps) {
  const taskSubject = event.hook_data?.raw_hook_data?.task_subject || '';
  const teammateName = event.hook_data?.raw_hook_data?.teammate_name || '';
  return (
    <>
      {teammateName && (
        <Badge variant="outline" className={`${CHIP} opacity-60`}>
          {teammateName}
        </Badge>
      )}
      {taskSubject && <span>{truncate(taskSubject, 50)}</span>}
    </>
  );
}

const STATUS_COLORS: Record<string, string> = {
  completed: 'border-green-500/50 text-green-500',
  in_progress: 'border-blue-500/50 text-blue-500',
  pending: 'border-muted-foreground/50 text-muted-foreground',
  deleted: 'border-red-500/50 text-red-500',
};

function TaskCreateOneLiner({ event }: EventPartProps) {
  const subject = event.hook_data?.tool_input?.subject || '';
  if (!subject) return null;
  return <>{truncate(subject, 50)}</>;
}

function TaskUpdateOneLiner({ event }: EventPartProps) {
  const taskId = event.hook_data?.tool_input?.taskId || '';
  const status = event.hook_data?.tool_input?.status || '';
  if (!taskId) return null;
  return (
    <>
      <Badge variant="outline" className={CHIP}>
        #{taskId}
      </Badge>
      {status && (
        <Badge variant="outline" className={`${CHIP} ${STATUS_COLORS[status] || ''}`}>
          {status}
        </Badge>
      )}
    </>
  );
}

function NotificationOneLiner({ event }: EventPartProps) {
  const notifType = event.hook_data?.raw_hook_data?.notification_type || '';
  const message = event.hook_data?.message || event.hook_data?.raw_hook_data?.message || '';
  return (
    <>
      {notifType && (
        <Badge variant="outline" className={`${CHIP} opacity-60`}>
          {notifType}
        </Badge>
      )}
      {message && <span>{truncate(message, 50)}</span>}
    </>
  );
}

function ConfigChangeOneLiner({ event }: EventPartProps) {
  const source = event.hook_data?.raw_hook_data?.source || '';
  const filePath = event.hook_data?.raw_hook_data?.file_path || '';
  return (
    <>
      {source && (
        <Badge variant="outline" className={CHIP}>
          {source}
        </Badge>
      )}
      {filePath && <span className="opacity-60">{shortenPath(filePath)}</span>}
    </>
  );
}

function WorktreeCreateOneLiner({ event }: EventPartProps) {
  const name = event.hook_data?.raw_hook_data?.name || '';
  if (!name) return null;
  return (
    <Badge variant="outline" className={CHIP}>
      {name}
    </Badge>
  );
}

function WorktreeRemoveOneLiner({ event }: EventPartProps) {
  const worktreePath = event.hook_data?.raw_hook_data?.worktree_path || '';
  if (!worktreePath) return null;
  return <span className="opacity-60">{shortenPath(worktreePath)}</span>;
}

const ACTION_COLORS: Record<string, string> = {
  block: 'border-red-500/50 text-red-500',
  add_context: 'border-blue-500/50 text-blue-500',
  notify: 'border-yellow-500/50 text-yellow-500',
};

function RulesExecutedOneLiner({ event }: EventPartProps) {
  const eventData = event.hook_data?.event_data;
  const hookEvent = eventData?.hook_event || '';
  const actions: any[] = eventData?.actions;
  if (!Array.isArray(actions) || actions.length === 0) return null;
  return (
    <>
      {hookEvent && (
        <Badge variant="outline" className={`${CHIP} opacity-60`}>
          {hookEvent}
        </Badge>
      )}
      {actions.map((a: any, i: number) => (
        <Badge key={i} variant="outline" className={`${CHIP} ${ACTION_COLORS[a.action] || ''}`}>
          {a.rule}:{a.action}
        </Badge>
      ))}
    </>
  );
}

function UserPromptSubmitOneLiner({ event }: EventPartProps) {
  const prompt = event.hook_data?.prompt || event.hook_data?.raw_hook_data?.prompt || '';
  if (!prompt) return null;
  const words = prompt.trim().split(/\s+/).filter(Boolean);
  const summary = words.length <= 6 ? words.join(' ') : words.slice(0, 6).join(' ') + '\u2026';
  return <>{summary}</>;
}

// ---------------------------------------------------------------------------
// Config registries — keyed by tool_name or event_type (hook_event_name)
//
// To add a new sub-component for a tool, add a new field to EventSummaryConfig
// and populate it here. The EventOneLiner (and future components) will pick it
// up automatically.
// ---------------------------------------------------------------------------

/** Per-tool_name configs */
const TOOL_CONFIGS: Record<string, EventSummaryConfig> = {
  TodoWrite: { oneLiner: TodoWriteOneLiner },
  Read: { oneLiner: ReadOneLiner },
  Write: { oneLiner: WriteOneLiner },
  Edit: { oneLiner: EditOneLiner },
  Bash: { oneLiner: BashOneLiner },
  Grep: { oneLiner: GrepOneLiner },
  Glob: { oneLiner: GlobOneLiner },
  Task: { oneLiner: TaskOneLiner },
  WebFetch: { oneLiner: WebFetchOneLiner },
  WebSearch: { oneLiner: WebSearchOneLiner },
  NotebookEdit: { oneLiner: EditOneLiner },
  Skill: { oneLiner: SkillOneLiner },
  TaskCreate: { oneLiner: TaskCreateOneLiner },
  TaskUpdate: { oneLiner: TaskUpdateOneLiner },
};

/** Per-event_type configs (non-tool events) */
const EVENT_TYPE_CONFIGS: Record<string, EventSummaryConfig> = {
  UserPromptSubmit: { oneLiner: UserPromptSubmitOneLiner },
  PostToolUseFailure: { oneLiner: PostToolUseFailureOneLiner },
  SubagentStart: { oneLiner: SubagentStartOneLiner },
  SubagentStop: { oneLiner: SubagentStopOneLiner },
  TeammateIdle: { oneLiner: TeammateIdleOneLiner },
  TaskCreated: { oneLiner: TaskCreatedOneLiner },
  TaskCompleted: { oneLiner: TaskCompletedOneLiner },
  Notification: { oneLiner: NotificationOneLiner },
  ConfigChange: { oneLiner: ConfigChangeOneLiner },
  WorktreeCreate: { oneLiner: WorktreeCreateOneLiner },
  WorktreeRemove: { oneLiner: WorktreeRemoveOneLiner },
  rules_executed: { oneLiner: RulesExecutedOneLiner },
};

/** Resolve the config for a given event (tool_name takes priority) */
export function getEventConfig(event: SnifferEvent): EventSummaryConfig | null {
  const toolName = event.hook_data?.tool_name;
  if (toolName && TOOL_CONFIGS[toolName]) return TOOL_CONFIGS[toolName];
  if (EVENT_TYPE_CONFIGS[event.event_type]) return EVENT_TYPE_CONFIGS[event.event_type];
  return null;
}

// ---------------------------------------------------------------------------
// Generic fallback (for unregistered tools / events)
// ---------------------------------------------------------------------------

function genericOneLiner(hookData?: Record<string, any>): string {
  if (!hookData) return '';
  const candidate =
    hookData.tool_input?.command ||
    hookData.tool_input?.pattern ||
    hookData.tool_input?.file_path ||
    hookData.tool_input?.query ||
    hookData.tool_input?.url ||
    hookData.tool_input?.prompt ||
    hookData.raw_hook_data?.stop_reason ||
    '';
  const text = typeof candidate === 'string' ? candidate : JSON.stringify(candidate);
  const words = text.split(/\s+/).filter(Boolean);
  return words.length <= 5 ? words.join(' ') : words.slice(0, 5).join(' ') + '\u2026';
}

// ---------------------------------------------------------------------------
// CwdChip — shows last 3 segments of cwd with full-path tooltip
// ---------------------------------------------------------------------------

function extractCwd(event: SnifferEvent): string {
  return event.hook_data?.raw_hook_data?.cwd || event.hook_data?.cwd || '';
}

function shortenCwd(cwd: string): string {
  if (!cwd) return '';
  const parts = cwd.split('/').filter(Boolean);
  if (parts.length <= 3) return cwd;
  return '\u2026/' + parts.slice(-3).join('/');
}

function CwdChip({ event }: EventPartProps) {
  const cwd = extractCwd(event);
  if (!cwd) return null;
  const short = shortenCwd(cwd);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="ms-auto max-w-[180px] shrink-0 truncate text-[10px] text-muted-foreground">{short}</span>
      </TooltipTrigger>
      <TooltipContent side="top">{cwd}</TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// EventOneLiner — main component
// ---------------------------------------------------------------------------

interface EventOneLinerProps {
  event: SnifferEvent;
  className?: string;
}

export function EventOneLiner({ event, className }: EventOneLinerProps) {
  const hookData = event.hook_data;
  const toolName = hookData?.tool_name;
  const cwd = extractCwd(event);

  // Determine inline content
  let content: React.ReactNode = null;

  const planWrite = isPlanWrite(event);

  if (event.summary) {
    // 1. Synthetic events (info / notification layer)
    content = event.summary;
  } else if (toolName) {
    // 2. Tool events — chips + one-liner detail
    const config = TOOL_CONFIGS[toolName];
    const OneLiner = config?.oneLiner;
    const detail = OneLiner ? <OneLiner event={event} /> : genericOneLiner(hookData) || null;
    content = (
      <>
        <ToolNameChips toolName={toolName} />
        {planWrite && <Badge className={`${CHIP} border-amber-500/50 bg-amber-500/15 text-amber-500`}>Plan</Badge>}
        {detail}
      </>
    );
  } else {
    // 3. Event-type-specific (UserPromptSubmit, etc.)
    const eventConfig = EVENT_TYPE_CONFIGS[event.event_type];
    if (eventConfig?.oneLiner) {
      const OneLiner = eventConfig.oneLiner;
      content = <OneLiner event={event} />;
    } else {
      // 4. Fallback
      const fallback = genericOneLiner(hookData);
      if (fallback) content = fallback;
    }
  }

  if (!content && !cwd) return null;

  // Strip 'truncate' from outer container — truncation is on the inner content span
  const outerClass = className?.replace(/\btruncate\b/, '').trim();

  return (
    <span className={cn('flex min-w-0 items-center gap-1', outerClass)}>
      {content && <span className="min-w-0 truncate">{content}</span>}
      {cwd && <CwdChip event={event} />}
    </span>
  );
}
