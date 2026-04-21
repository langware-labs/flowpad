import {
  AgenticProcess,
  ComputeNode,
  Flow,
  FlowElementTypes,
  TypeId,
  type FlowData,
  type ITrigger,
} from '@sdk';
import { useProcess, useProcessActions, useProcessExecution, useProcessStream } from '@sdk/react/hooks';
import { AutoScrollContainer, AutoScrollContainerHandle } from '@src/components/AutoScrollContainer';
import ChatMessage from '@src/pages/flow-page/chat-panel/chat-message/chat-message';
import { useProject } from '@src/hooks/useProject';
import { cn } from '@src/lib/utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CompactChatInput } from './CompactChatInput';
import { useProcessesForTarget } from './hooks/useProcessesForTarget';

interface EntityChatPanelProps {
  target: TypeId | null;
  className?: string;
}

/**
 * Compact chat panel attached to an arbitrary host entity (markdown file, trigger, …).
 *
 * Process lifecycle:
 *   - Queries AgenticProcess by `target_typeid_str === target.toString()`.
 *   - If a process already exists, it's reused (chat persistence is free).
 *   - If none, one is created lazily on the first send via `computeNode.createProcess`,
 *     then `flow.sendMessage(text)` on the resulting Flow.
 *
 * Keeps intentionally off the legacy `useSendMessageStore` singleton so it can
 * coexist with the flow-page `ChatPanel` without clobbering its pendingMessage.
 */
export function EntityChatPanel({ target, className }: EntityChatPanelProps) {
  const targetStr = useMemo(() => target?.toString() || '', [target]);

  // 1. Find an existing attached process (latest wins).
  const { processes, isLoading: listLoading } = useProcessesForTarget(targetStr);
  const latestProcess: AgenticProcess | null = useMemo(() => {
    if (!processes.length) return null;
    return [...processes].sort((a, b) => {
      const ta = new Date(a.updated_date || a.created_date || 0).getTime();
      const tb = new Date(b.updated_date || b.created_date || 0).getTime();
      return tb - ta;
    })[0] ?? null;
  }, [processes]);

  // 2. Resolve the Flow entity for the process.
  const processTypeId = useMemo(
    () => (latestProcess?.id ? new TypeId(AgenticProcess.type, latestProcess.id) : null),
    [latestProcess?.id],
  );
  const { data: flow } = useProcess(processTypeId, { enabled: !!processTypeId });
  const { data: stream } = useProcessStream(flow as Flow | null);
  const { isRunning } = useProcessExecution(flow as Flow | null);
  const { send } = useProcessActions(flow as Flow | null);

  // 3. Project workdir (needed for lazy create).
  const { project } = useProject();

  // Creation guard so we don't spawn two processes when the user double-sends.
  const createInFlightRef = useRef(false);
  const [createdFlow, setCreatedFlow] = useState<Flow | null>(null);
  const effectiveFlow: Flow | null = (flow as Flow | null) ?? createdFlow;
  // If the queried process catches up to a just-created one, drop the local handle.
  useEffect(() => {
    if (createdFlow && flow) setCreatedFlow(null);
  }, [flow, createdFlow]);
  const { send: sendOnCreated } = useProcessActions(createdFlow);

  const handleSend = useCallback(async (text: string) => {
    if (!target) return;

    // Reuse existing process if we have one.
    if (effectiveFlow) {
      if (flow) await send(text);
      else await sendOnCreated(text);
      return;
    }

    // Lazy create.
    if (createInFlightRef.current) return;
    createInFlightRef.current = true;
    try {
      const computeNode = await ComputeNode.getById('@local');
      if (!computeNode) throw new Error('No local compute node');
      const workdir = project?.fs_storage_mount_path ?? undefined;
      const newProcess = await computeNode.createProcess({
        workdir,
        projectId: project?.id,
        targetTypeIdStr: target.toString(),
      });
      await newProcess.start({ headless: true });
      // Wrap the spawned process as a Flow so useProcessActions can drive it.
      const flowHandle = new Flow({ id: newProcess.id });
      setCreatedFlow(flowHandle);
      await flowHandle.sendMessage(text, { processId: newProcess.id, flowMode: 'Agent' });
    } finally {
      createInFlightRef.current = false;
    }
  }, [effectiveFlow, flow, send, sendOnCreated, target, project]);

  const messages = useMemo(() => {
    const items: FlowData[] = stream?.data ?? [];
    return items.filter((d) => {
      const t: string = d.elementType;
      return (
        t === FlowElementTypes.USER_MESSAGE ||
        t === FlowElementTypes.CHAT ||
        t === FlowElementTypes.TEXT
      );
    });
  }, [stream]);

  const scrollRef = useRef<AutoScrollContainerHandle>(null);
  // Scroll-to-bottom on new message.
  useEffect(() => {
    scrollRef.current?.scrollToBottom();
  }, [messages.length]);

  const hasFlow = !!effectiveFlow;
  const showEmptyState = !hasFlow && !listLoading && !createInFlightRef.current;

  return (
    <div
      className={cn('flex h-full min-h-0 flex-col bg-background', className)}
      data-testid="entity-chat-panel"
    >
      <AutoScrollContainer
        ref={scrollRef}
        className="flex-1 overflow-y-auto"
      >
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
      <CompactChatInput
        onSend={handleSend}
        disabled={!target || isRunning || createInFlightRef.current}
      />
    </div>
  );
}

// Quiet unused-import warnings from SDK re-exports.
export type { AgenticProcess, Flow, FlowData, ITrigger };
