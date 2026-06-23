import { useState } from 'react';
import { Filter } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { ScopeFilterBar } from '@src/components/scope-filter/ScopeFilterBar';
import { isAllScope, scopeProjectIds, type ScopeFilter } from '@src/lib/scope-filter';

interface ScopeFilterPopoverProps {
  scope: ScopeFilter;
  currentProjectId: string | null;
  onScopeChange: (next: ScopeFilter) => void;
}

function chipLabel(scope: ScopeFilter): string {
  if (isAllScope(scope)) return 'All';
  const n = scopeProjectIds(scope).length;
  if (n > 0) return `Project (${n})`;
  return 'User';
}

export function ScopeFilterPopover({ scope, currentProjectId, onScopeChange }: ScopeFilterPopoverProps) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
          data-testid="spotlight-scope-chip"
        >
          <Filter className="h-3.5 w-3.5" />
          <span>{chipLabel(scope)}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-auto p-2"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <ScopeFilterBar scope={scope} currentProjectId={currentProjectId} onScopeChange={onScopeChange} />
      </PopoverContent>
    </Popover>
  );
}
