import { useMemo, useState } from 'react';
import { Tag } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { cn } from '@src/lib/utils';
import { RECORD_TYPES, TYPE_COLORS, TYPE_DISPLAY_NAMES } from '@src/components/record-search-bar/RecordSearchBar';

interface EntityTypePopoverProps {
  /** Currently selected single record_type (null = no filter / all of allowedEntityTypes). */
  value: string | null;
  onChange: (next: string | null) => void;
  /** Restricts the popover list. When omitted, falls back to the full RECORD_TYPES list. */
  allowedEntityTypes?: string[];
}

function chipLabel(value: string | null): string {
  if (!value) return 'All types';
  return TYPE_DISPLAY_NAMES[value] ?? value;
}

export function EntityTypePopover({ value, onChange, allowedEntityTypes }: EntityTypePopoverProps) {
  const [open, setOpen] = useState(false);
  const types = useMemo(
    () => (allowedEntityTypes && allowedEntityTypes.length > 0 ? allowedEntityTypes : RECORD_TYPES),
    [allowedEntityTypes],
  );
  const showAll = !allowedEntityTypes || allowedEntityTypes.length > 1;

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
          data-testid="spotlight-entity-chip"
        >
          <Tag className="h-3.5 w-3.5" />
          <span>{chipLabel(value)}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 p-2"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex flex-wrap items-center gap-1">
          {showAll && (
            <button
              type="button"
              onClick={() => { onChange(null); setOpen(false); }}
              className={cn(
                'rounded px-1.5 py-0.5 text-xs transition-colors',
                value === null
                  ? 'bg-primary/20 text-primary'
                  : 'border border-border/50 bg-background text-muted-foreground hover:bg-muted hover:border-border',
              )}
            >
              All
            </button>
          )}
          {types.map((t) => {
            const active = value === t;
            return (
              <button
                key={t}
                type="button"
                onClick={() => { onChange(active ? null : t); setOpen(false); }}
                className={cn(
                  'rounded px-1.5 py-0.5 text-xs transition-colors',
                  active
                    ? (TYPE_COLORS[t] ?? 'bg-primary/20 text-primary')
                    : 'border border-border/50 bg-background text-muted-foreground hover:bg-muted hover:border-border',
                )}
              >
                {TYPE_DISPLAY_NAMES[t] ?? t}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
