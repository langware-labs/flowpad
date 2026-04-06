import { useState } from 'react';
import { AgenticProcess, ProcessorStatus, TypeId } from '@sdk';
import { useEntityData } from '@sdk/react/hooks';
import { cn } from '@src/lib/utils';
import { useAgenticProcessState } from './hooks/use-agentic-process-state';
import { CompactProgressBar } from './compact-progress-bar';
import { FullProgressModal } from './full-progress-modal';

interface AgenticProgressViewerProps {
  process?: AgenticProcess | null;
  filePath?: string;
  onAbort?: () => void;
  className?: string;
  defaultExpanded?: boolean;
}

export function AgenticProgressViewer({
  process,
  filePath,
  onAbort: _onAbort,
  className,
  defaultExpanded = false,
}: AgenticProgressViewerProps) {
  const [isModalOpen, setIsModalOpen] = useState(defaultExpanded);

  const processTypeId = process ? new TypeId('agentic_process', process.id) : null;
  const { flowData, isComplete: flowDataComplete, count: flowDataCount } = useEntityData(processTypeId);

  const { status, completed } = useAgenticProcessState(process);
  const displayStatus = status ?? ProcessorStatus.IDLE;

  return (
    <div className={cn('w-full', className)} data-testid="agentic-progress-viewer">
      <CompactProgressBar
        status={displayStatus}
        filePath={filePath}
        onExpand={() => setIsModalOpen(true)}
        flowDataCount={flowDataCount}
      />

      <FullProgressModal
        open={isModalOpen}
        onOpenChange={setIsModalOpen}
        status={displayStatus}
        filePath={filePath}
        flowData={flowData}
        flowDataCount={flowDataCount}
      />

      <div data-testid="flow-data-count" className="hidden">{flowDataCount}</div>
      <div data-testid="flow-data-complete" className="hidden">{flowDataComplete ? 'true' : 'false'}</div>
      <div data-testid="process-status" className="hidden">{displayStatus}</div>
      <div data-testid="process-completed" className="hidden">{completed ? 'true' : 'false'}</div>
    </div>
  );
}

export { CompactProgressBar } from './compact-progress-bar';
export { FullProgressModal } from './full-progress-modal';
