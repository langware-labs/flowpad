import type { SnifferEvent } from '@src/hooks/use-hooks-sniffer';
import { useSnifferPipeline, SnifferScope, SnifferLevel, type PipelineFilters } from '@src/hooks/use-sniffer-pipeline';
import { useEventFilterMask } from '@src/hooks/use-event-filter-mask';
import { EventListPanel } from '@src/components/hooks/EventListPanel';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Activity } from 'lucide-react';
import { useMemo, useState } from 'react';

export const DEFAULT_DIALOG_FILTERS: PipelineFilters = { scope: SnifferScope.All, level: SnifferLevel.Debug };

export function SessionEventsDialog({
  open,
  onOpenChange,
  sessionName,
  events,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionName: string;
  events: SnifferEvent[];
}) {
  const { mask, removeFilter, clearAll: clearMask } = useEventFilterMask();
  const [filters, setFilters] = useState<PipelineFilters>(DEFAULT_DIALOG_FILTERS);

  const handleFilterChange = (update: Partial<PipelineFilters>) => {
    setFilters((prev) => ({ ...prev, ...update }));
  };

  const pipelineFilters = useMemo<PipelineFilters>(
    () => ({ ...filters, mask: Object.keys(mask).length > 0 ? mask : undefined }),
    [filters, mask],
  );
  const { filteredEvents } = useSnifferPipeline(events, pipelineFilters);
  const reversed = useMemo(() => [...filteredEvents].reverse(), [filteredEvents]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-4xl overflow-hidden p-0">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle className="flex items-center gap-2 pe-6 text-sm">
            <Activity className="h-4 w-4 shrink-0 text-primary" />
            <span className="min-w-0 truncate">{sessionName}</span>
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto p-2">
          <EventListPanel
            events={reversed}
            filters={filters}
            onFilterChange={handleFilterChange}
            mask={mask}
            onMaskRemove={removeFilter}
            onMaskClearAll={clearMask}
            onDismiss={() => onOpenChange(false)}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
