import type { FilterMask } from '@src/hooks/use-event-filter-mask';
import { cn } from '@src/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { Filter, X } from 'lucide-react';
import { Trans } from '@lingui/react/macro';

interface FilterMaskIndicatorProps {
  mask: FilterMask;
  onRemove: (key: string) => void;
  onClearAll: () => void;
}

export function FilterMaskIndicator({ mask, onRemove, onClearAll }: FilterMaskIndicatorProps) {
  const entries = Object.entries(mask);
  if (entries.length === 0) return null;

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button className="relative flex items-center rounded-md p-1 text-primary transition-colors hover:bg-accent">
              <Filter className="h-3.5 w-3.5" />
              <span className="absolute -right-1 -top-1 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-bold text-primary-foreground">
                {entries.length}
              </span>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent><Trans>Active filters</Trans></TooltipContent>
      </Tooltip>
      <PopoverContent side="bottom" align="start" className="w-64 p-2">
        <div className="space-y-1">
          <div className="flex items-center justify-between px-1 pb-1">
            <span className="text-[10px] font-semibold text-muted-foreground"><Trans>Active Filters</Trans></span>
            <button className="text-[10px] text-muted-foreground hover:text-foreground" onClick={onClearAll}>
              <Trans>Clear all</Trans>
            </button>
          </div>
          {entries.map(([key, value]) => (
            <div key={key} className="flex items-center gap-2 rounded-md bg-muted/50 px-2 py-1.5">
              <span className="shrink-0 text-[10px] font-medium text-foreground">{key}:</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className={cn('min-w-0 flex-1 truncate text-[10px] text-muted-foreground')}>{value}</span>
                </TooltipTrigger>
                <TooltipContent side="bottom">{value}</TooltipContent>
              </Tooltip>
              <button
                className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                onClick={() => onRemove(key)}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
