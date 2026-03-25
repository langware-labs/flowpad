import { type ProjectResourceListItem, type ProjectResourceType } from '@src/components/project-resource-list';
import type { SnifferEvent } from '@src/hooks/use-hooks-sniffer';
import { isClassificationTask, isActionTask, getArtifactPaths, openArtifact } from '@src/components/task-bar/task-utils';
import type { Task } from '@sdk';
import { useAnalysisTaskProgress } from '@src/hooks/use-analysis-task-progress';
import { useClassificationResult } from '@src/hooks/use-classification-result';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { getEventIcon, getEventColor, getOneLiner } from '@src/components/hooks/event-utils';
import {
  Bot,
  CheckSquare,
  Command,
  FileText,
  FolderOpen,
  Loader2,
  Maximize2,
  Plug,
  RefreshCw,
  ScanSearch,
  Search,
  Settings,
  Sparkles,
  Terminal,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { formatTimeAgo } from './project-activity-utils';
import { SessionEventsDialog } from './SessionEventsDialog';
import { SessionStatusDot } from '@src/components/ui/session-status-dot';
import './ProjectActivityStrip.css';

interface ResourceMeta {
  label: string;
  icon: LucideIcon;
}

const RESOURCE_META: Record<ProjectResourceType, ResourceMeta> = {
  skill: { label: 'Skill', icon: Sparkles },
  mcp_server: { label: 'MCP Server', icon: Plug },
  plugin: { label: 'Plugin', icon: Settings },
  hook: { label: 'Hook', icon: Terminal },
  command: { label: 'Command', icon: Command },
  agent: { label: 'Agent', icon: Bot },
  session: { label: 'Session', icon: FolderOpen },
  todo: { label: 'Todo', icon: CheckSquare },
  claude_md: { label: 'CLAUDE.md', icon: FileText },
};

// ---------------------------------------------------------------------------
// renderEventIndicator — shared rendering for the event indicator line
// ---------------------------------------------------------------------------

function renderEventIndicator(
  event: SnifferEvent | null,
  count: number,
  sessionId: string,
  sessionName: string,
  onOpenEventDialog?: (sessionId: string, name: string) => void,
) {
  if (event) {
    const EvtIcon = getEventIcon(event.event_type, event);
    const evtColor = getEventColor(event);
    const oneLiner = getOneLiner(event.hook_data);
    return (
      <button
        type="button"
        className="activity-event-indicator"
        onClick={(e) => {
          e.stopPropagation();
          onOpenEventDialog?.(sessionId, sessionName);
        }}
      >
        {count > 0 && (
          <span className="activity-event-badge">{count}</span>
        )}
        <Maximize2 className="h-3 w-3 shrink-0 text-muted-foreground" />
        <EvtIcon className={`h-3 w-3 shrink-0 ${evtColor}`} />
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">
          {event.event_type}{oneLiner ? ` · ${oneLiner}` : ''}
        </span>
      </button>
    );
  }
  if (count > 0) {
    return (
      <button
        type="button"
        className="activity-event-badge"
        onClick={(e) => {
          e.stopPropagation();
          onOpenEventDialog?.(sessionId, sessionName);
        }}
      >
        {count}
      </button>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// SessionRow — extracted so it can call useAnalysisTaskProgress
// ---------------------------------------------------------------------------

interface SessionRowProps {
  item: ProjectResourceListItem;
  classificationTask: Task | null;
  actionTask: Task | null;
  isWorkerSession: boolean;
  eventCount: number;
  latestEvent: SnifferEvent | null;
  isLoading: boolean;
  actingSessionId?: string | null;
  onItemClick?: (item: ProjectResourceListItem) => void;
  onSessionResume?: (item: ProjectResourceListItem) => void;
  onSessionTasks?: (item: ProjectResourceListItem) => void;
  onSessionClassify?: (item: ProjectResourceListItem) => void;
  onActAccordingToClassification?: (item: ProjectResourceListItem, command: string) => void;
  onOpenEventDialog?: (sessionId: string, name: string) => void;
}

function SessionRow({
  item,
  classificationTask,
  actionTask,
  isWorkerSession,
  eventCount,
  latestEvent,
  isLoading,
  actingSessionId,
  onItemClick,
  onSessionResume,
  onSessionTasks,
  onSessionClassify,
  onActAccordingToClassification,
  onOpenEventDialog,
}: SessionRowProps) {
  const { isRunning: isClassifyRunning } = useAnalysisTaskProgress(classificationTask);
  const { isRunning: isActionRunning, isComplete: isActionComplete } = useAnalysisTaskProgress(actionTask);
  const classificationInfo = useClassificationResult(classificationTask);
  const { navigation } = useDockNavigation();
  const timeAgo = formatTimeAgo(item.modifiedAt);
  const actionArtifacts = actionTask ? getArtifactPaths(actionTask) : [];
  const projectLabel = item.path?.split('/').filter(Boolean).pop() ?? null;

  function renderClassifyButton() {
    // Worker sessions (spawned to run classifications) should not show a classify button
    if (isWorkerSession) return null;

    const isRunning = isClassifyRunning;
    // A session is classified if we have classification results (from task metadata or classification.json file)
    const isClassified = !!classificationInfo;
    const isDisabled = isRunning || isClassified;

    let title = 'Classify session';
    if (isRunning) {
      title = 'Classifying...';
    } else if (isClassified) {
      title = 'Already classified';
    }

    return (
      <button
        type="button"
        className="activity-resume-button"
        data-testid="classify-button"
        title={title}
        disabled={isDisabled}
        onClick={(e) => {
          e.stopPropagation();
          if (!isDisabled) {
            onSessionClassify?.(item);
          }
        }}
      >
        {isRunning ? (
          <Loader2 className="h-4 w-4 animate-spin text-amber-500" />
        ) : (
          <ScanSearch className={`h-4 w-4${isClassified ? ' opacity-40' : ''}`} />
        )}
      </button>
    );
  }

  return (
    <div
      className={`activity-card ${isLoading ? 'pointer-events-none opacity-50' : ''}`}
      {...(item.sessionId ? { 'data-session-id': item.sessionId } : {})}
      onClick={() => onItemClick?.(item)}
    >
      {/* Full-width name at top */}
      <div className="activity-card-name">
        <span className="activity-name-text">
          {item.name.split('\n').find((l) => l.trim()) ?? item.name}
        </span>
        {isClassifyRunning && (
          <span className="activity-name-subtitle">Classifying...</span>
        )}
        {!isClassifyRunning && classificationInfo && (() => {
          const isActing = isActionRunning || actingSessionId === item.sessionId;

          if (isActionComplete && actionArtifacts.length > 0) {
            return (
              <span className="activity-name-subtitle flex items-center gap-1.5">
                {actionArtifacts.map((artifact) => (
                  <button
                    key={artifact.path}
                    type="button"
                    className="activity-classification-link"
                    data-testid="artifact-link"
                    title={artifact.path}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (artifact.skillDockPath) {
                        navigation.openDock(DockPointer.forSkills(artifact.skillDockPath));
                      } else {
                        openArtifact(artifact.path, navigation);
                      }
                    }}
                  >
                    {artifact.label}
                  </button>
                ))}
              </span>
            );
          }

          if (isActing) {
            return (
              <span className="activity-name-subtitle flex items-center gap-1 opacity-60" data-testid="action-running">
                <Loader2 className="inline h-3 w-3 animate-spin" />
                Creating {classificationInfo.category}...
              </span>
            );
          }

          if (onActAccordingToClassification) {
            return (
              <button
                type="button"
                className="activity-classification-link"
                data-testid="classification-link"
                title={`Create ${classificationInfo.category}: ${classificationInfo.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onActAccordingToClassification(item, classificationInfo.command);
                }}
              >
                <span className="classification-category">{classificationInfo.category}</span>
                {classificationInfo.title}
              </button>
            );
          }

          return null;
        })()}
        {!isClassifyRunning && !classificationInfo && item.subtitle && (
          <span className="activity-name-subtitle">{item.subtitle.split('\n').find((l) => l.trim()) ?? item.subtitle}</span>
        )}
        {renderEventIndicator(latestEvent, eventCount, item.sessionId ?? '', item.name, onOpenEventDialog)}
      </div>

      {/* Bottom row: time + actions */}
      <div className="activity-card-meta">
        <span className="activity-card-time">
          {item.status && <SessionStatusDot status={item.status} />}
          {timeAgo}
          {!!item.messageCount && <span className="activity-card-msgs">{item.messageCount} msgs</span>}
        </span>
        {onSessionResume && (
          <div className="activity-cell-actions">
            {item.taskPath && onSessionTasks && (
              <button
                type="button"
                className="activity-resume-button"
                title="View session tasks"
                onClick={(e) => {
                  e.stopPropagation();
                  onSessionTasks(item);
                }}
              >
                <CheckSquare className="h-4 w-4" />
              </button>
            )}
            {item.type === 'claude_session' && onSessionClassify && renderClassifyButton()}
            <button
              type="button"
              className="activity-resume-button"
              title="Resume session in terminal"
              onClick={(e) => {
                e.stopPropagation();
                onSessionResume(item);
              }}
            >
              <Terminal className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
      {projectLabel && (
        <span className="activity-card-project">{projectLabel}</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProjectActivityStrip
// ---------------------------------------------------------------------------

export interface ProjectActivityStripProps {
  items: ProjectResourceListItem[];
  onItemClick?: (item: ProjectResourceListItem) => void;
  onSessionResume?: (item: ProjectResourceListItem) => void;
  /** Open session tasks in lens viewer */
  onSessionTasks?: (item: ProjectResourceListItem) => void;
  /** Run classification on the session */
  onSessionClassify?: (item: ProjectResourceListItem) => void;
  /** Execute the action from a completed classification */
  onActAccordingToClassification?: (item: ProjectResourceListItem, command: string) => void;
  /** Map of session ID → event count for notification badges */
  sessionEventCounts?: Map<string, number>;
  /** All sniffer events (used to show event detail dialog) */
  snifferEvents?: SnifferEvent[];
  /** Session ID currently being loaded (upsert in flight) */
  loadingSessionId?: string | null;
  /** Whether activity data is still loading */
  isLoading?: boolean;
  /** Callback to refresh activity data */
  onRefresh?: () => void;
  maxItems?: number;
  /** Analysis tasks used to show analyze buttons on sessions */
  learningTasks?: Task[];
  /** Session ID currently being acted on (create-skill, etc.) */
  actingSessionId?: string | null;
}

export function ProjectActivityStrip({
  items,
  onItemClick,
  onSessionResume,
  onSessionTasks,
  onSessionClassify,
  onActAccordingToClassification,
  sessionEventCounts,
  snifferEvents,
  loadingSessionId,
  isLoading,
  onRefresh,
  maxItems = 20,
  learningTasks = [],
  actingSessionId,
}: ProjectActivityStripProps) {
  const [search, setSearch] = useState('');
  const [dialogSessionId, setDialogSessionId] = useState<string | null>(null);
  const [dialogSessionName, setDialogSessionName] = useState('');

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return items.slice(0, maxItems);
    return items
      .filter((item) => {
        const meta = RESOURCE_META[item.type];
        return (
          item.name.toLowerCase().includes(query) ||
          (item.subtitle || '').toLowerCase().includes(query) ||
          (meta?.label || item.type).toLowerCase().includes(query)
        );
      })
      .slice(0, maxItems);
  }, [items, search, maxItems]);

  // Build sessionId → classification/action Task lookups AND worker session IDs in a single pass.
  // Prefer the most recently updated task.
  const { sessionClassificationMap, sessionActionMap, workerSessionIds } = useMemo(() => {
    const classMap = new Map<string, Task>();
    const actionMap = new Map<string, Task>();
    const workers = new Set<string>();

    const upsert = (map: Map<string, Task>, sid: string, t: Task) => {
      const existing = map.get(sid);
      if (!existing || (t.updated_date ?? 0) > (existing.updated_date ?? 0)) {
        map.set(sid, t);
      }
    };

    for (const t of learningTasks) {
      const wid = t.metadata?.workerSessionId;
      if (typeof wid === 'string' && (isClassificationTask(t) || isActionTask(t))) workers.add(wid);

      const sid = t.metadata?.sessionId;
      if (typeof sid !== 'string') continue;

      if (isClassificationTask(t)) upsert(classMap, sid, t);
      if (isActionTask(t)) upsert(actionMap, sid, t);
    }
    return { sessionClassificationMap: classMap, sessionActionMap: actionMap, workerSessionIds: workers };
  }, [learningTasks]);

  // Map each session ID to its most recent sniffer event
  const sessionLatestEvent = useMemo(() => {
    const map = new Map<string, SnifferEvent>();
    if (!snifferEvents) return map;
    for (const evt of snifferEvents) {
      const sid = evt.session_id;
      if (!sid) continue;
      const existing = map.get(sid);
      if (!existing || new Date(evt.timestamp).getTime() > new Date(existing.timestamp).getTime()) {
        map.set(sid, evt);
      }
    }
    return map;
  }, [snifferEvents]);

  const dialogEvents = useMemo(() => {
    if (!dialogSessionId || !snifferEvents) return [];
    return snifferEvents
      .filter((e) => e.session_id === dialogSessionId)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [dialogSessionId, snifferEvents]);

  const refreshButton = onRefresh && (
    <button
      type="button"
      className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      onClick={onRefresh}
      title="Refresh activity"
    >
      <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
    </button>
  );

  if (items.length === 0 && !isLoading) {
    return (
      <div className="activity-table" data-testid="project-activity-strip">
        <div className="activity-table-header">
          <span className="activity-table-title">Current Activity</span>
          {refreshButton}
        </div>
        <div className="flex flex-1 flex-col items-center justify-center py-12">
          <span className="text-sm text-muted-foreground">No recent activity</span>
        </div>
      </div>
    );
  }

  return (
    <div className="activity-table" data-testid="project-activity-strip">
      <div className="activity-table-header">
        <span className="activity-table-title">Current Activity</span>
        {refreshButton}
        <div className="activity-table-search">
          <Search className="activity-table-search-icon" />
          <input
            className="activity-table-search-input"
            type="text"
            placeholder="Filter..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="activity-table-scroll">
        {filtered.length === 0 ? (
          <div className="activity-cell-empty">
            {search.trim() ? 'No matching sessions' : 'No recent sessions'}
          </div>
        ) : (
          filtered.map((item) => (
            <SessionRow
              key={item.id}
              item={item}
              classificationTask={item.sessionId ? sessionClassificationMap.get(item.sessionId) ?? null : null}
              actionTask={item.sessionId ? sessionActionMap.get(item.sessionId) ?? null : null}
              isWorkerSession={!!item.sessionId && workerSessionIds.has(item.sessionId)}
              eventCount={item.sessionId ? (sessionEventCounts?.get(item.sessionId) ?? 0) : 0}
              latestEvent={item.sessionId ? (sessionLatestEvent.get(item.sessionId) ?? null) : null}
              isLoading={!!loadingSessionId && loadingSessionId === item.sessionId}
              actingSessionId={actingSessionId}
              onItemClick={onItemClick}
              onSessionResume={onSessionResume}
              onSessionTasks={onSessionTasks}
              onSessionClassify={onSessionClassify}
              onActAccordingToClassification={onActAccordingToClassification}
              onOpenEventDialog={(sid, name) => {
                setDialogSessionId(sid);
                setDialogSessionName(name);
              }}
            />
          ))
        )}
      </div>

      {/* Event detail dialog */}
      <SessionEventsDialog
        open={!!dialogSessionId}
        onOpenChange={(open) => {
          if (!open) setDialogSessionId(null);
        }}
        sessionName={dialogSessionName}
        events={dialogEvents}
      />
    </div>
  );
}

export default ProjectActivityStrip;
