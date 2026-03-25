import {
  AgentHook,
  dataContext,
  type FlowData,
  type HooksSnifferStatus,
  snifferManager,
  VFSPath,
  getTranscriptDockPointer,
  getTriggerLogDockPointer,
  parseTranscriptPath,
} from '@sdk';
import { defineGlobal } from '@sdk/utils';
import { useContext, useEntityData } from '@sdk/react/hooks';
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useClaudeProjectList } from './use-claude-projects';

export type EventLayer = 'debug' | 'info' | 'raw_notifications' | 'resource';

export type SnifferEvent = {
  id: string;
  idx: number;
  timestamp: string;
  webhook_type: string;
  event_type: string;
  hook_entry_id?: string;
  hook_file_path?: string;
  transcript_path?: string;
  session_id?: string;
  hook_data?: Record<string, any>;
  raw_line: string;
  layer: EventLayer;
  summary?: string;
  source_event_id?: string;
  skill_usage_count?: number;
  warning?: string;
  error?: string;
  /** Pre-computed transcript lens pointer. Null for SessionStart and events without a transcript. */
  transcriptDockPointer: { ref: string; options: Record<string, string> } | null;
  /** Pre-computed trigger log lens pointer. Null for events without a hook_entry_id. */
  triggerLogDockPointer: { ref: string; options: Record<string, string> } | null;
};

const SNIFFER_CLEAR_EVENT = 'hooks-sniffer-clear';
const MAX_EVENTS_STORAGE_KEY = 'flowpad-sniffer-max-events';
const DEFAULT_MAX_EVENTS = 100;

function loadMaxEvents(): number {
  try {
    const stored = localStorage.getItem(MAX_EVENTS_STORAGE_KEY);
    if (stored) {
      const val = parseInt(stored, 10);
      if (val > 0 && val <= 10000) return val;
    }
  } catch {
    // ignore
  }
  return DEFAULT_MAX_EVENTS;
}

function safeParse(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Extract OS working directory from a raw FlowData payload */
function extractOsPath(item: FlowData): string | null {
  const raw = item?.data ?? item?.rawData;
  const payload: any = typeof raw === 'string' ? safeParse(raw) : raw;
  if (!payload) return null;
  return (
    payload.hook_data?.cwd ??
    payload.hook_data?.raw_hook_data?.cwd ??
    payload.event?.context?.cwd ??
    payload.data?.event_data?.context?.cwd ??
    null
  );
}

/** Extract session_id from a raw FlowData payload */
function extractSessionId(item: FlowData): string | null {
  const raw = item?.data ?? item?.rawData;
  const payload: any = typeof raw === 'string' ? safeParse(raw) : raw;
  if (!payload) return null;
  return (
    payload.hook_data?.raw_hook_data?.session_id ??
    payload.hook_data?.session_id ??
    payload.event?.context?.session_id ??
    payload.data?.event_data?.context?.session_id ??
    null
  );
}

function saveMaxEvents(val: number): void {
  try {
    localStorage.setItem(MAX_EVENTS_STORAGE_KEY, String(val));
  } catch {
    // ignore
  }
}

export function useHooksSniffer() {
  const [hookId, setHookId] = useState<string | null>(() => dataContext.snifferHook?.entity.id ?? null);
  const [isToggling, setIsToggling] = useState(false);
  const [hookEntity, setHookEntity] = useState<AgentHook | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [maxEvents, setMaxEventsRaw] = useState(loadMaxEvents);
  const pausedSnapshot = useRef<readonly any[]>([]);
  const globalIndexOffsetRef = useRef(0);

  const setMaxEvents: Dispatch<SetStateAction<number>> = useCallback((action) => {
    setMaxEventsRaw((prev) => {
      const next = typeof action === 'function' ? action(prev) : action;
      saveMaxEvents(next);
      return next;
    });
  }, []);

  const { flowData, clear: clearFlowData } = useEntityData(hookEntity?.typeId);
  const { projects } = useClaudeProjectList();
  const { computeNode, snifferEnabled, isBootstrapping } = useContext();
  const isLoading = isBootstrapping;
  const status: HooksSnifferStatus = { enabled: snifferEnabled, hook_id: hookId };
  const sessionToProjectRef = useRef<Map<string, string | null>>(new Map());

  const projectFlowDataCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const computeNodeTypeId = computeNode?.typeId;

    if (!computeNodeTypeId) return counts;

    // Pre-compute project VFSPaths
    const projectVfsPaths: Array<{ encoded_name: string; vfs: VFSPath }> = [];
    if (computeNodeTypeId) {
      for (const p of projects) {
        if (p.cwd) {
          try {
            projectVfsPaths.push({
              encoded_name: p.encoded_name,
              vfs: VFSPath.fromMachinePath(p.cwd, computeNodeTypeId),
            });
          } catch {
            /* skip invalid paths */
          }
        }
      }
    }

    for (const item of flowData) {
      const sessionId = extractSessionId(item);

      // 1. Check cache (slug)
      if (sessionId && sessionToProjectRef.current.has(sessionId)) {
        const cached = sessionToProjectRef.current.get(sessionId)!;
        if (cached) counts.set(cached, (counts.get(cached) ?? 0) + 1);
        continue;
      }

      // 2. VFS isChild resolution
      const osPath = extractOsPath(item);
      if (!osPath || !computeNodeTypeId) {
        if (sessionId) {
          sessionToProjectRef.current.set(sessionId, null);
          console.warn('[Sniffer] Cannot resolve project — no cwd available', {
            webhook_type: item?.attributes?.webhook_type,
            sessionId,
          });
        }
        // Items with no sessionId and no osPath (e.g. hook_op events) have no
        // project context by design — skip silently without caching.
        continue;
      }

      let matched: string | null = null;
      try {
        const itemVfs = VFSPath.fromMachinePath(osPath, computeNodeTypeId);
        for (const { encoded_name, vfs } of projectVfsPaths) {
          if (vfs.isChild(itemVfs)) {
            matched = encoded_name;
            break;
          }
        }
      } catch {
        /* invalid path */
      }

      if (matched) {
        counts.set(matched, (counts.get(matched) ?? 0) + 1);
      }

      // Cache for this session
      if (sessionId) sessionToProjectRef.current.set(sessionId, matched);
    }

    return counts;
  }, [flowData, projects]);

  const clear = useCallback(() => {
    clearFlowData();
    sessionToProjectRef.current.clear();
    globalIndexOffsetRef.current = 0;
    if (hookEntity && 'flowDataStream' in hookEntity) {
      (hookEntity as any).flowDataStream.clear();
    }
    // Broadcast to all other hook instances so they clear too
    window.dispatchEvent(new CustomEvent(SNIFFER_CLEAR_EVENT));
  }, [clearFlowData, hookEntity]);

  // Listen for clear from other instances of this hook
  useEffect(() => {
    const handler = () => {
      clearFlowData();
      globalIndexOffsetRef.current = 0;
    };
    window.addEventListener(SNIFFER_CLEAR_EVENT, handler);
    return () => window.removeEventListener(SNIFFER_CLEAR_EVENT, handler);
  }, [clearFlowData]);

  // Trim the underlying stream when it exceeds maxEvents
  useEffect(() => {
    if (!hookEntity || !('flowDataStream' in hookEntity)) return;
    const stream = (hookEntity as any).flowDataStream;
    const items: any[] = stream._ownItems;
    if (items && items.length > maxEvents) {
      const trimCount = items.length - maxEvents;
      globalIndexOffsetRef.current += trimCount;
      items.splice(0, trimCount);
    }
  }, [flowData, hookEntity, maxEvents]);

  useEffect(() => {
    if (isPaused) {
      pausedSnapshot.current = flowData;
    }
  }, [flowData, isPaused]);

  useEffect(() => {
    let unwatch: (() => Promise<void>) | null = null;
    let cancelled = false;

    if (!snifferEnabled || !hookId) {
      setHookEntity(null);
      clear();
      return undefined;
    }

    // Entity should already be in cache from bootstrap. Fall back to creating
    // without uname so the cache key matches the backend's flow-data target.
    const cached = AgentHook.getByIdFromCache(hookId);
    const entity = cached ?? new AgentHook({ id: hookId, name: 'Hooks Sniffer' });
    setHookEntity(entity);
    defineGlobal('sniffer', entity);

    void entity.watch().then((unsub) => {
      if (cancelled) {
        void unsub();
        return;
      }
      unwatch = unsub;
    });

    return () => {
      cancelled = true;
      if (unwatch) {
        void unwatch();
      }
    };
  }, [snifferEnabled, hookId, clear]);

  const events = useMemo(() => {
    const items = isPaused ? pausedSnapshot.current : flowData;
    const parsed: SnifferEvent[] = [];

    items.forEach((item, index) => {
      const attrs = item?.attributes;

      // hook_op events: unified CRUD + event + invoke + log dispatch
      if (attrs?.webhook_type === 'hook_op') {
        const raw = item?.data ?? item?.rawData ?? '';
        let rsPayload: any = null;
        if (typeof raw === 'string') {
          try {
            rsPayload = JSON.parse(raw);
          } catch {
            rsPayload = null;
          }
        } else if (typeof raw === 'object' && raw !== null) {
          rsPayload = raw;
        }

        const eventName = rsPayload?.data?.event_name;
        const rsType = rsPayload?.type ?? '';
        const rsOp = rsPayload?.operation ?? '';
        const eventType = eventName || `${rsType}:${rsOp}`;

        // Extract session_id from execution_scope or event_data context
        const scopeEntries: any[] = rsPayload?.execution_scope ?? [];
        const sessionEntry = scopeEntries.find((e: any) => e.type === 'claude_session');
        const sessionId = sessionEntry?.id ?? rsPayload?.data?.event_data?.context?.session_id ?? '';

        parsed.push({
          id: `${item.timestamp}-${index}`,
          idx: 0,
          timestamp: item.timestamp,
          webhook_type: 'hook_op',
          event_type: eventType,
          session_id: sessionId,
          hook_data: {
            operation: rsOp,
            resource_type: rsPayload?.resource_type,
            event_name: eventName,
            event_data: rsPayload?.data?.event_data,
          },
          raw_line: typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2),
          layer: 'debug',
          warning: item?.warning || attrs?.warning || undefined,
          error: item?.error_text || attrs?.error || undefined,
          transcriptDockPointer: null,
          triggerLogDockPointer: null,
        });
        return;
      }

      const raw = item?.data ?? item?.rawData ?? '';
      let payload: any = null;
      if (typeof raw === 'string') {
        try {
          payload = JSON.parse(raw);
        } catch {
          payload = null;
        }
      } else if (typeof raw === 'object' && raw !== null) {
        payload = raw;
      }

      // Transcript entries: no webhook_type but have entry.tools[]
      if (payload && !payload.webhook_type && Array.isArray(payload.entry?.tools) && payload.entry.tools.length > 0) {
        const rawJson = JSON.stringify(payload, null, 2);
        const transcriptEntryPath: string = payload.transcript_path || '';
        const parsedTranscriptEntry = transcriptEntryPath ? parseTranscriptPath(transcriptEntryPath) : null;
        const transcriptEntryPointer = parsedTranscriptEntry
          ? { ref: `${parsedTranscriptEntry.projectEncodedName}/${parsedTranscriptEntry.sessionId}`, options: { ts: item.timestamp } }
          : null;
        payload.entry.tools.forEach((tool: any, toolIdx: number) => {
          parsed.push({
            id: `${item.timestamp}-${index}-t${toolIdx}`,
            idx: 0,
            timestamp: item.timestamp,
            webhook_type: 'transcript_entry',
            event_type: tool.name || 'UnknownTool',
            transcript_path: transcriptEntryPath,
            session_id: payload.session_id || '',
            hook_data: {
              tool_id: tool.tool_id,
              tool_name: tool.name,
              tool_input: tool.input,
              entry_type: payload.entry.type,
            },
            raw_line: rawJson,
            layer: 'debug',
            transcriptDockPointer: transcriptEntryPointer,
            triggerLogDockPointer: null,
          });
        });
        return;
      }

      if (!payload || !payload.webhook_type) return;

      const webhookType: string = payload.webhook_type;
      const rawHookData = (payload.hook_data || {}).raw_hook_data || {};
      // Hoist tool_name / tool_input from raw_hook_data so EventOneLiner
      // sub-components can access them at hook_data.tool_name / .tool_input
      const hookData = {
        ...(payload.hook_data || {}),
        ...(rawHookData.tool_name ? { tool_name: rawHookData.tool_name } : {}),
        ...(rawHookData.tool_input ? { tool_input: rawHookData.tool_input } : {}),
      };
      const rawJson = JSON.stringify(payload, null, 2);

      // For agent_hook, use hook_event_name; for others, derive from payload
      let eventType: string;
      if (webhookType === 'agent_hook') {
        if (hookData.tool_name === 'Skill') {
          const skillName = hookData.tool_input?.skill || 'unknown';
          eventType = `SkillUsed:${skillName}`;
        } else {
          eventType = hookData.hook_event_name || 'Unknown';
        }
      } else if (webhookType === 'activation_rules') {
        eventType = payload.event?.type || webhookType;
      } else if (webhookType === 'skill_notification') {
        eventType = payload.notification?.skill_name || webhookType;
      } else if (webhookType === 'session_log') {
        eventType = payload.event?.type || webhookType;
      } else {
        eventType = webhookType;
      }

      // Extract warning/error from FlowData attributes
      const itemWarning = item?.warning || item?.attributes?.warning || undefined;
      const itemError = item?.error_text || item?.attributes?.error || undefined;

      parsed.push({
        id: `${item.timestamp}-${index}`,
        idx: 0,
        timestamp: item.timestamp,
        webhook_type: webhookType,
        event_type: eventType,
        hook_entry_id: payload.hook_entry_id || '',
        hook_file_path: payload.hook_file_path || '',
        transcript_path: rawHookData.transcript_path || '',
        session_id: rawHookData.session_id || hookData.session_id || payload.event?.context?.session_id || '',
        hook_data: hookData,
        raw_line: rawJson,
        layer: 'debug',
        skill_usage_count: hookData.skill_usage_count ?? undefined,
        warning: itemWarning,
        error: itemError,
        transcriptDockPointer: rawHookData.hook_event_name
          ? getTranscriptDockPointer(rawHookData, item.timestamp)
          : null,
        triggerLogDockPointer: getTriggerLogDockPointer(payload.hook_entry_id || null),
      });
    });

    // Assign globally-increasing index (survives trimming)
    const offset = globalIndexOffsetRef.current;
    for (let i = 0; i < parsed.length; i++) {
      parsed[i].idx = offset + i + 1;
    }

    return parsed;
  }, [flowData, isPaused]);

  const latestEvent = events.length > 0 ? events[events.length - 1] : null;

  const enable = useCallback(async () => {
    setIsToggling(true);
    try {
      const nextStatus = await snifferManager.enable();
      if (nextStatus.hook_id) setHookId(nextStatus.hook_id);
    } finally {
      setIsToggling(false);
    }
  }, []);

  const disable = useCallback(async () => {
    setIsToggling(true);
    try {
      await snifferManager.disable();
      clear();
    } finally {
      setIsToggling(false);
    }
  }, [clear]);

  const togglePause = useCallback(() => {
    setIsPaused((prev) => !prev);
  }, []);

  return {
    status,
    events,
    latestEvent,
    flowData,
    projectFlowDataCounts,
    isLoading,
    isToggling,
    isPaused,
    maxEvents,
    setMaxEvents,
    enable,
    disable,
    togglePause,
    clear,
  };
}
