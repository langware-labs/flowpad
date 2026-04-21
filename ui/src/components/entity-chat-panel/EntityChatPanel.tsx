import {
  AgenticProcess,
  ComputeNode,
  FlowElementTypes,
  TypeId,
  type FlowData,
} from '@sdk';
import { useProcess } from '@sdk/react/hooks';
import { AutoScrollContainer, AutoScrollContainerHandle } from '@src/components/AutoScrollContainer';
import ChatMessage from './chat-message/chat-message';
import { useProject } from '@src/hooks/useProject';
import { cn } from '@src/lib/utils';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CompactChatInput } from './CompactChatInput';
import { useProcessesForTarget } from './hooks/useProcessesForTarget';

/**
 * Subscribe to the `flowDataStream.items` on an AgenticProcess.
 *
 * The SDK's generic `useProcessStream` hook is Flow-specific — it reads
 * `flow.stream.items`, which doesn't exist on AgenticProcess. AgenticProcess
 * exposes `.flowDataStream` (an EventEmitter emitting `'data'`). This local
 * hook bridges that gap so this panel can stay off the Flow abstraction.
 */
function useAgenticProcessStream(process: AgenticProcess | null): FlowData[] {
  const snapshotRef = useRef<FlowData[]>([]);

  const subscribe = useCallback((cb: () => void) => {
    if (!process) return () => {};
    const onData = () => cb();
    const onClear = () => cb();
    process.flowDataStream.on('data', onData);
    process.flowDataStream.on('clear', onClear);
    return () => {
      process.flowDataStream.off('data', onData);
      process.flowDataStream.off('clear', onClear);
    };
  }, [process]);

  const getSnapshot = useCallback(() => {
    if (!process) {
      if (snapshotRef.current.length !== 0) snapshotRef.current = [];
      return snapshotRef.current;
    }
    const items = process.flowDataStream.items as FlowData[];
    if (
      items.length !== snapshotRef.current.length ||
      items.some((v, i) => v !== snapshotRef.current[i])
    ) {
      snapshotRef.current = [...items];
    }
    return snapshotRef.current;
  }, [process]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

interface EntityChatPanelProps {
  /**
   * Serialized attachment key, stored as-is in `AgenticProcess.target_typeid_str`.
   * Real entities: `new TypeId(Trigger.type, id).toString()` → `"trigger-<id>"`.
   * Markdown files (pseudo-entity): `"markdown_file-<path>"` — built inline since file paths
   * don't pass `TypeId.isValidIdentifier`.
   */
  target: string | null;
  className?: string;
}

/**
 * Compact chat panel attached to an arbitrary host entity (markdown file, trigger, …).
 *
 * Process lifecycle:
 *   - Queries AgenticProcess by `target_typeid_str === target`.
 *   - If a process already exists, reuse it (chat persistence survives reloads).
 *   - If none, create one lazily on the first send via `computeNode.createProcess({
 *       targetTypeIdStr, outputFormat: "stream-json" })`. Print-mode processes
 *     don't spawn a PTY, so no `start({headless})` needed.
 *   - Every send invokes `process.prompt(text)` which POSTs to the streaming
 *     `prompt` action on AgenticProcess; FlowData flows into `process.flowDataStream`
 *     and renders via `useProcessStream`.
 */
export function EntityChatPanel({ target, className }: EntityChatPanelProps) {
  const targetStr = target ?? '';

  // 1. Find an existing attached process (latest wins; user's explicit pick
  //    comes later via the History button — v1 just auto-picks newest).
  const { processes, isLoading: listLoading } = useProcessesForTarget(targetStr);
  const latestProcess: AgenticProcess | null = useMemo(() => {
    if (!processes.length) return null;
    return [...processes].sort((a, b) => {
      const ta = new Date(a.updated_date || a.created_date || 0).getTime();
      const tb = new Date(b.updated_date || b.created_date || 0).getTime();
      return tb - ta;
    })[0] ?? null;
  }, [processes]);

  // 2. Resolve the full AgenticProcess entity (the one returned by
  //    useProcessesForTarget may be partial; useProcess gives us the watched instance).
  const processTypeId = useMemo(
    () => (latestProcess?.id ? new TypeId(AgenticProcess.type, latestProcess.id) : null),
    [latestProcess?.id],
  );
  const { data: resolvedProcess } = useProcess(processTypeId, { enabled: !!processTypeId });

  // 3. Creation guard — a locally-spawned process survives until the query
  //    picks it up on the next tick.
  const createInFlightRef = useRef(false);
  const [localProcess, setLocalProcess] = useState<AgenticProcess | null>(null);
  useEffect(() => {
    if (localProcess && resolvedProcess?.id === localProcess.id) setLocalProcess(null);
  }, [resolvedProcess?.id, localProcess]);

  const activeProcess: AgenticProcess | null =
    (resolvedProcess as AgenticProcess | null | undefined) ?? localProcess;

  // Hydrate history on first resolution. Per AgenticProcess.loadHistory, safe to
  // call repeatedly — internally guarded by `_historyLoaded`.
  useEffect(() => {
    if (!activeProcess) return;
    void activeProcess.loadHistory().catch((err) => {
      console.error('[EntityChatPanel] loadHistory failed', err);
    });
  }, [activeProcess?.id]);

  // Stream ingestion — FlowStreamProcessor (inside AgenticProcess.prompt) appends
  // to flowDataStream; our local hook subscribes to its 'data' event.
  const items = useAgenticProcessStream(activeProcess);
  const messages = useMemo(() => {
    return items.filter((d) => {
      const t: string = d.elementType;
      return (
        t === FlowElementTypes.USER_MESSAGE ||
        t === FlowElementTypes.CHAT ||
        t === FlowElementTypes.TEXT
      );
    });
  }, [items]);

  // 4. Project workdir + id (lazy-create inputs).
  const { project } = useProject();

  // 5. In-flight tracking for the send button gate.
  const [sending, setSending] = useState(false);

  const handleSend = useCallback(async (text: string) => {
    if (!targetStr || sending) return;
    setSending(true);
    try {
      let proc = activeProcess;

      // Lazy-create on first send.
      if (!proc) {
        if (createInFlightRef.current) return;
        createInFlightRef.current = true;
        try {
          const computeNode = await ComputeNode.getById('@local');
          if (!computeNode) throw new Error('No local compute node');
          const newProcess = await computeNode.createProcess({
            workdir: project?.fs_storage_mount_path ?? undefined,
            projectId: project?.id,
            targetTypeIdStr: targetStr,
            outputFormat: 'stream-json',
          });
          setLocalProcess(newProcess);
          proc = newProcess;
        } finally {
          createInFlightRef.current = false;
        }
      }

      if (!proc) throw new Error('process creation failed');

      await proc.prompt(text);
    } catch (err) {
      console.error('[EntityChatPanel] prompt failed', err);
    } finally {
      setSending(false);
    }
  }, [activeProcess, sending, targetStr, project]);

  const scrollRef = useRef<AutoScrollContainerHandle>(null);
  useEffect(() => {
    scrollRef.current?.scrollToBottom();
  }, [messages.length]);

  const showEmptyState = !activeProcess && !listLoading && !sending;
  const sendDisabled = !targetStr || sending;

  return (
    <div
      className={cn('flex h-full min-h-0 flex-col bg-background', className)}
      data-testid="entity-chat-panel"
    >
      <AutoScrollContainer ref={scrollRef} className="flex-1 overflow-y-auto">
        {showEmptyState && (
          <div className="p-3 text-[11px] text-muted-foreground">
            Ask about this document. The conversation will persist.
          </div>
        )}
        {messages.map((m) => (
          <ChatMessage
            key={m.id ?? m.timestamp}
            flowData={m}
            isUser={
              m.elementType === FlowElementTypes.USER_MESSAGE ||
              (m.attributes && m.attributes.role === 'user')
            }
          />
        ))}
      </AutoScrollContainer>
      <CompactChatInput onSend={handleSend} disabled={sendDisabled} />
    </div>
  );
}

// Re-export so outer callers can thread SDK types without a second import.
export type { AgenticProcess, FlowData, TypeId };
