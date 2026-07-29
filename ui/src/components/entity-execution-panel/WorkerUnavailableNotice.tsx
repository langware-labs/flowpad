import type { FlowData } from '@sdk';
import { AlertTriangle } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';

import { WorkerTypeSelect } from '@src/components/workers/WorkerTypeSelect';
import { normalizeWorkerType, type WorkerType } from '@src/components/workers/worker-types';
import { workerLabel } from '@src/components/lens-viewer/shared/transcript-features/transcript-utils';

interface WorkerUnavailablePayload {
  message?: unknown;
  worker_type?: unknown;
}

export function WorkerUnavailableNotice({
  flowData,
  worker,
  onWorkerChange,
}: {
  flowData: FlowData;
  worker?: string;
  onWorkerChange?: (worker: WorkerType) => void | Promise<void>;
}) {
  const { t } = useLingui();
  const payload =
    flowData.data && typeof flowData.data === 'object' ? (flowData.data as WorkerUnavailablePayload) : null;
  const workerType =
    typeof payload?.worker_type === 'string' ? payload.worker_type : (flowData.attributes['worker-type'] ?? worker);
  const unavailableWorker = normalizeWorkerType(workerType);
  const payloadMessage = typeof payload?.message === 'string' ? payload.message.trim() : '';
  const textMessage = typeof flowData.data === 'string' ? flowData.data.trim() : '';
  const message = payloadMessage || textMessage || t`This worker cannot continue the chat right now.`;

  return (
    <div
      role="alert"
      data-testid="worker-unavailable-notice"
      className="mx-3 my-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] p-3 shadow-sm"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 rounded-full bg-amber-500/15 p-1.5 text-amber-600 dark:text-amber-400">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{t`${workerLabel(unavailableWorker)} is unavailable`}</p>
          <p className="mt-0.5 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">{message}</p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">{t`Choose another worker`}</span>
            <WorkerTypeSelect
              value={unavailableWorker}
              onChange={(next) => onWorkerChange?.(next)}
              disabled={!onWorkerChange}
              testId="worker-unavailable-worker-select"
              triggerClassName="border-amber-500/30 bg-background/80"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
