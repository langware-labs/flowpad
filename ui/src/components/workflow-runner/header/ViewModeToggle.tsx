import { Switch } from '@src/components/ui/switch';
import { ListTree } from 'lucide-react';

import type { ViewMode } from '../data/types';

interface ViewModeToggleProps {
  viewMode: ViewMode;
  onChange: (m: ViewMode) => void;
}

export function ViewModeToggle({ viewMode, onChange }: ViewModeToggleProps) {
  const detailed = viewMode === 'expert';
  return (
    <label
      data-testid="view-mode-toggle"
      data-active={detailed ? 'true' : 'false'}
      className="flex cursor-pointer items-center gap-2 rounded-md border bg-background px-2 py-1 text-xs"
    >
      <ListTree className="h-3 w-3 text-muted-foreground" />
      <span className="font-medium">Detailed view</span>
      <Switch
        checked={detailed}
        onCheckedChange={(next) => onChange(next ? 'expert' : 'simple')}
        aria-label="Toggle detailed view"
      />
    </label>
  );
}
