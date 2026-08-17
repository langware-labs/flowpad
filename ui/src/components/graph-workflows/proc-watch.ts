/**
 * Per-process live status subscriptions.
 *
 * The backend's ProcessStatusReport stream (flow_data_msg, kind=process_status)
 * is WATCHER-SCOPED: we must `watch()` each spawned process to receive it.
 * Driven by node_status events: `started`+process_id → hydrate/watch/subscribe;
 * `slot_freed` → tear down.
 */
import { AgenticProcess } from '@sdk/process/agentic-process';
import type { NodeStatusPayload } from '@sdk/services/graph-workflows';
import { useStudio } from './store';

interface WatchEntry {
  unwatch?: () => Promise<void>;
  off?: () => void;
}

const active = new Map<string, WatchEntry>();

async function startWatch(processId: string): Promise<void> {
  if (active.has(processId)) return;
  const entry: WatchEntry = {};
  active.set(processId, entry);
  try {
    const proc = await AgenticProcess.getById(processId);
    if (!proc) return;
    const onReport = (report: {
      worker_status?: string;
      process_status?: string;
      busy?: boolean;
    }) => {
      useStudio.getState().setProcStatus(processId, {
        workerStatus: String(report.worker_status ?? ''),
        processStatus: String(report.process_status ?? ''),
        busy: !!report.busy,
        ts: Date.now(),
      });
    };
    proc.on('status_report', onReport);
    entry.off = () => proc.off('status_report', onReport);
    entry.unwatch = await proc.watch();
    // Seed from whatever the entity already knows.
    const seed = (proc as unknown as { statusReport?: Record<string, unknown> }).statusReport;
    if (seed) onReport(seed as never);
  } catch (e) {
    console.error('proc-watch: failed to watch', processId, e);
  }
}

function stopWatch(processId: string): void {
  const entry = active.get(processId);
  if (!entry) return;
  active.delete(processId);
  entry.off?.();
  void entry.unwatch?.().catch(() => undefined);
  useStudio.getState().clearProcStatus(processId);
}

/** Wire into the flowManager 'node_status' stream. Call once at boot. */
export function handleNodeStatusForProcWatch(msg: NodeStatusPayload): void {
  const pid = msg.detail?.process_id;
  if (msg.phase === 'started' && typeof pid === 'string') void startWatch(pid);
  if ((msg.phase === 'finished' || msg.phase === 'failed') && typeof pid === 'string') {
    stopWatch(pid);
  }
}
