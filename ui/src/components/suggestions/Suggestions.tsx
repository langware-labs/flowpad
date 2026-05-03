import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dataContext, fsManager, type Task } from '@sdk';
import type { ProjectResourceListItem } from '@src/components/project-resource-list';
import {
  isClassificationTask,
  isActionTask,
  getClassificationInfo,
  type ClassificationInfo,
} from '@src/components/task-bar/task-utils';
import { Switch } from '@src/components/ui/switch';
import { Brain, BookOpen, Loader2, ScanSearch, Sparkles, Webhook } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

const CATEGORY_ICON: Record<string, LucideIcon> = {
  skill: Sparkles,
  memory: Brain,
  rule: BookOpen,
  hook: Webhook,
};

interface UnactedClassification {
  sessionId: string;
  info: ClassificationInfo;
  resource: ProjectResourceListItem;
}

export interface SuggestionsProps {
  learningTasks: Task[];
  projectResourceItems: ProjectResourceListItem[];
  fallbackCwd?: string;
  onClassifySession: (sessionId: string, cwd: string) => Promise<void>;
  onActOnClassification: (resource: ProjectResourceListItem, command: string) => void;
  actingSessionId: string | null;
  classifyingSessionIds: ReadonlySet<string>;
}

function getTodayMidnight(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function getYesterdayMidnight(): number {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function Suggestions({
  learningTasks,
  projectResourceItems,
  fallbackCwd,
  onClassifySession,
  onActOnClassification,
  actingSessionId,
  classifyingSessionIds,
}: SuggestionsProps) {
  const [autoAnalyze, setAutoAnalyze] = useState(false);
  const autoTriggered = useRef(false);

  const todayMidnight = useMemo(() => getTodayMidnight(), []);
  const yesterdayMidnight = useMemo(() => getYesterdayMidnight(), []);

  // Resource lookup: sessionId → resource item
  const resourceMap = useMemo(() => {
    const map = new Map<string, ProjectResourceListItem>();
    for (const r of projectResourceItems) {
      if (r.sessionId) map.set(r.sessionId, r);
    }
    return map;
  }, [projectResourceItems]);

  // Session IDs that already have an action task (acted on)
  const actedSessionIds = useMemo(() => {
    const set = new Set<string>();
    for (const t of learningTasks) {
      if (isActionTask(t)) {
        const sid = t.session_id;
        if (typeof sid === 'string') set.add(sid);
      }
    }
    return set;
  }, [learningTasks]);

  // All classification tasks that have results (done or have classification_path).
  // Deduplicate by session_id, preferring 'done' status.
  const completedClassifications = useMemo(() => {
    const seen = new Map<string, Task>();
    for (const t of learningTasks) {
      if (!isClassificationTask(t)) continue;
      const sid = t.session_id;
      if (typeof sid !== 'string') continue;
      const hasResult = t.status === 'done' || typeof t.classification_path === 'string';
      if (!hasResult) continue;
      const existing = seen.get(sid);
      if (!existing || (t.status === 'done' && existing.status !== 'done')) {
        seen.set(sid, t);
      }
    }
    return [...seen.values()];
  }, [learningTasks]);

  // Set of all classified session IDs (for the analyze button filter)
  const classifiedSessionIds = useMemo(
    () => new Set(completedClassifications.map((t) => t.session_id as string)),
    [completedClassifications],
  );

  // File-read fallback: read classification.json for tasks missing classification fields.
  // Run once on mount (or when completedClassifications changes) — not a reactive loop.
  const [fileClassifications, setFileClassifications] = useState<Map<string, ClassificationInfo>>(new Map());
  const fileReadRanRef = useRef(false);

  useEffect(() => {
    if (fileReadRanRef.current) return;
    const toRead = completedClassifications.filter((t) => {
      const sid = t.session_id as string;
      if (actedSessionIds.has(sid)) return false;
      if (getClassificationInfo(t)) return false;
      return typeof t.classification_path === 'string' || typeof t.output_dir === 'string';
    });
    if (toRead.length === 0) return;

    const computeNodeTypeId = dataContext.computeNode?.typeId;
    if (!computeNodeTypeId) return;

    fileReadRanRef.current = true;

    const readAll = async () => {
      const results = new Map<string, ClassificationInfo>();
      await Promise.allSettled(
        toRead.map(async (t) => {
          const path =
            t.classification_path ||
            `${(t.output_dir as string).replace(/\\/g, '/')}/classification.json`;
          const sid = t.session_id as string;
          try {
            const content = await fsManager.download(computeNodeTypeId, path);
            if (!content) return;
            const text = typeof content === 'string' ? content : new TextDecoder().decode(content as ArrayBuffer);
            const parsed = JSON.parse(text);
            if (parsed.category && parsed.title && parsed.command) {
              results.set(sid, { category: parsed.category, title: parsed.title, command: parsed.command });
            }
          } catch {
            // File not readable — skip
          }
        }),
      );
      if (results.size > 0) {
        setFileClassifications(results);
      }
    };
    void readAll();
  }, [completedClassifications, actedSessionIds]);

  // Unacted classifications with full info, matched to a known session resource.
  // Only show classifications for sessions from today or yesterday.
  const unactedClassifications = useMemo<UnactedClassification[]>(() => {
    const results: UnactedClassification[] = [];

    for (const t of completedClassifications) {
      const sid = t.session_id as string;
      if (actedSessionIds.has(sid)) continue;
      const info = getClassificationInfo(t) ?? fileClassifications.get(sid) ?? null;
      if (!info) continue;
      const resource = resourceMap.get(sid);
      if (!resource) continue;
      // Only show suggestions for sessions from today or yesterday
      if (resource.modifiedAt) {
        const ts = new Date(resource.modifiedAt).getTime();
        if (ts < yesterdayMidnight) continue;
      }
      results.push({ sessionId: sid, info, resource });
      if (results.length >= 4) break;
    }
    return results;
  }, [completedClassifications, actedSessionIds, resourceMap, fileClassifications, yesterdayMidnight]);

  // Unclassified sessions to offer for analysis.
  // Prefer yesterday's sessions; if none, fall back to most recent unclassified (LIFO).
  const { sessionsToAnalyze, isYesterday } = useMemo(() => {
    const unclassified = projectResourceItems.filter(
      (item) => item.sessionId && item.modifiedAt && !classifiedSessionIds.has(item.sessionId),
    );

    const yesterdays = unclassified.filter((item) => {
      const ts = new Date(item.modifiedAt!).getTime();
      return ts >= yesterdayMidnight && ts < todayMidnight;
    });

    if (yesterdays.length > 0) {
      return { sessionsToAnalyze: yesterdays.slice(0, 4), isYesterday: true };
    }
    return { sessionsToAnalyze: unclassified.slice(0, 4), isYesterday: false };
  }, [projectResourceItems, classifiedSessionIds, yesterdayMidnight, todayMidnight]);

  const classifyUnclassified = useCallback(() => {
    for (const session of sessionsToAnalyze) {
      const cwd = session.path || fallbackCwd;
      if (session.sessionId && cwd) {
        void onClassifySession(session.sessionId, cwd);
      }
    }
  }, [sessionsToAnalyze, fallbackCwd, onClassifySession]);

  // Auto-trigger classification when the switch is turned on
  useEffect(() => {
    if (!autoAnalyze) return;
    if (autoTriggered.current) return;
    if (classifyingSessionIds.size > 0) return;
    if (sessionsToAnalyze.length === 0) return;

    autoTriggered.current = true;
    classifyUnclassified();
  }, [autoAnalyze, classifyingSessionIds.size, sessionsToAnalyze, classifyUnclassified]);

  const classifyingCount = classifyingSessionIds.size;

  // Auto-analyze switch (always visible when component renders)
  const autoSwitch = (
    <div className="ml-auto flex items-center gap-2">
      <label htmlFor="auto-analyze" className="text-xs text-muted-foreground">
        Auto Run Daily
      </label>
      <Switch
        id="auto-analyze"
        checked={autoAnalyze}
        onCheckedChange={setAutoAnalyze}
      />
    </div>
  );

  // State A: Loading — classifications running
  if (classifyingCount > 0 && unactedClassifications.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/30 px-4 py-3">
        <Loader2 className="h-4 w-4 animate-spin text-amber-500" />
        <span className="text-sm text-muted-foreground">
          Analyzing {classifyingCount} session{classifyingCount > 1 ? 's' : ''}...
        </span>
        {autoSwitch}
      </div>
    );
  }

  // State B: Suggestions ready (show 2x2 grid + switch)
  if (unactedClassifications.length > 0) {
    return (
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-2">
          {unactedClassifications.map(({ sessionId, info, resource }) => {
            const Icon = CATEGORY_ICON[info.category] ?? Sparkles;
            const isActing = actingSessionId === sessionId;

            return (
              <button
                key={sessionId}
                type="button"
                className="flex items-center gap-2 rounded-full border border-border/50 bg-muted/30 px-4 py-2.5 text-left text-sm transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={isActing}
                onClick={() => onActOnClassification(resource, info.command)}
              >
                {isActing ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-amber-500" />
                ) : (
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 truncate">
                  <span className="font-medium capitalize text-muted-foreground">{info.category}</span>
                  {' '}
                  <span className="text-foreground">{info.title}</span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center px-1">
          {autoSwitch}
        </div>
      </div>
    );
  }

  // State C: Unclassified sessions available — show analyze button
  if (sessionsToAnalyze.length > 0) {
    const count = sessionsToAnalyze.length;
    const label = isYesterday
      ? `Analyze yesterday's ${count > 1 ? `last ${count} sessions` : 'session'}`
      : `Analyze last ${count} session${count > 1 ? 's' : ''}`;

    return (
      <div className="flex items-center gap-3 rounded-lg border border-border/50 bg-muted/30 px-4 py-3">
        <button
          type="button"
          className="flex items-center gap-2 rounded-md bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary transition-colors hover:bg-primary/20"
          onClick={classifyUnclassified}
        >
          <ScanSearch className="h-4 w-4" />
          {label}
        </button>
        {autoSwitch}
      </div>
    );
  }

  return null;
}
