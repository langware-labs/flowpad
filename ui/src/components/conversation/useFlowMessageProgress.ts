import { ConnectionManager, TypeId } from '@sdk';
import { FlowMessage } from '@sdk/entities/flow-message';
import { useEffect, useState } from 'react';

/** A live body-transfer reading for one FlowMessage. */
export interface FlowMessageProgress {
  /** 'upload' on the sender side, 'download' on the receiver side. */
  phase: 'upload' | 'download';
  bytesDone: number;
  /** 0 when the size is unknown (hub sent no Content-Length). */
  bytesTotal: number;
  /** 0..1, clamped. 0 when bytesTotal is unknown — render indeterminate. */
  fraction: number;
}

/**
 * Subscribe to body upload/download progress for a single FlowMessage.
 *
 * The local backend fans `flow_data_msg` events (element_type
 * `upload_progress` / `download_progress`) as the `.flowmsg` bundle moves to
 * or from the hub. They arrive on the existing `ConnectionManager`
 * `on_flow_data` channel — the same plumbing `DataManager` uses — so no new
 * transport is needed; this hook just taps it and filters by message id.
 *
 * Returns `null` when no transfer is in flight (idle, or just completed —
 * a terminal `bytes_done >= bytes_total` event clears the reading so the
 * bar disappears and the chip's own state takes over).
 */
export function useFlowMessageProgress(messageId: string): FlowMessageProgress | null {
  const [progress, setProgress] = useState<FlowMessageProgress | null>(null);

  useEffect(() => {
    setProgress(null);
    const cm = ConnectionManager.getInstance();
    const handler = (typeId: TypeId, flowData: unknown) => {
      if (typeId?.type !== FlowMessage.type || typeId?.id !== messageId) return;
      const fd = (flowData ?? {}) as {
        element_type?: string;
        elementType?: string;
        attributes?: Record<string, unknown>;
      };
      const el = fd.element_type ?? fd.elementType;
      if (el !== 'upload_progress' && el !== 'download_progress') return;
      const attrs = fd.attributes ?? {};
      const done = Number(attrs.bytes_done ?? 0);
      const total = Number(attrs.bytes_total ?? 0);
      // Terminal frame — transfer finished; drop the bar.
      if (total > 0 && done >= total) {
        setProgress(null);
        return;
      }
      setProgress({
        phase: el === 'upload_progress' ? 'upload' : 'download',
        bytesDone: done,
        bytesTotal: total,
        fraction: total > 0 ? Math.min(1, done / total) : 0,
      });
    };
    cm.on('on_flow_data', handler);
    return () => cm.off('on_flow_data', handler);
  }, [messageId]);

  return progress;
}
