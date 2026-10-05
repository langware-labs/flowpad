/**
 * A minimal AgenticProcess stand-in for tests of the chat activity line: a REAL `FlowDataStream`
 * plus the fields the line and `useTurnActivity` actually read.
 */
import { FlowData, FlowDataStream, WorkerStatus } from '@sdk';

export function fakeProcess(opts: { busy?: boolean; frames?: FlowData[]; workerStatus?: WorkerStatus | null } = {}) {
  const { busy = true, frames = [], workerStatus = WorkerStatus.TOOL_CALL } = opts;
  const stream = new FlowDataStream('chat-activity-line-test');
  if (frames.length) stream.ingestBatch(frames);
  const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
  return {
    id: 'p-1',
    session_id: 's-1',
    status: 'running',
    busy,
    workerStatus: workerStatus ?? undefined,
    isPrompting: false,
    flowDataStream: stream,
    on(evt: string, cb: (...a: unknown[]) => void) {
      if (!listeners.has(evt)) listeners.set(evt, new Set());
      listeners.get(evt)!.add(cb);
      return () => listeners.get(evt)!.delete(cb);
    },
    off(evt: string, cb: (...a: unknown[]) => void) {
      listeners.get(evt)?.delete(cb);
    },
  };
}
