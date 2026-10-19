import { useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { Button } from '@src/components/ui/button';
import { cn } from '@src/lib/utils';
import type { Browseable } from '@src/components/browseable-tree/types';
import type { TreeSelectionApi } from '@src/components/browseable-tree/useTreeSelection';
import type { MultiSelectAction, MultiSelectActionContext } from './types';

/**
 * Generic selection bar shown in the navigator header when ≥1 row is selected.
 * Layout is fixed ("N selected" · actions · clear ✕); the action buttons come
 * from the descriptor's `bulkActions` resolver, so each navigator (and each
 * selected type) gets its own toolbar content over identical chrome.
 */
export function SelectionActionBar({
  selection,
  actions,
}: {
  selection: TreeSelectionApi;
  actions: MultiSelectAction[];
}) {
  const { t } = useLingui();
  const selected = selection.selectedNodes;
  const ctx = { scopeRootId: selection.scopeRootId, clearSelection: selection.clear };

  return (
    <div
      className="flex flex-shrink-0 items-center gap-1 border-b bg-muted/40 px-1.5 py-1"
      data-testid="navigator-selection-bar"
    >
      <span className="text-xs font-medium text-muted-foreground" data-testid="navigator-selection-count">
        {t`${selection.count} selected`}
      </span>
      <div className="ms-auto flex items-center gap-0.5">
        {actions.map((action) => (
          <SelectionActionButton key={action.id} action={action} selected={selected} ctx={ctx} />
        ))}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={selection.clear}
          title={t`Clear selection`}
          aria-label={t`Clear selection`}
          data-testid="navigator-selection-clear"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function SelectionActionButton({
  action,
  selected,
  ctx,
}: {
  action: MultiSelectAction;
  selected: Browseable[];
  ctx: MultiSelectActionContext;
}) {
  const [busy, setBusy] = useState(false);
  const disabled = busy || (action.enabledWhen ? !action.enabledWhen(selected) : false);

  const handleClick = async () => {
    const result = action.run(selected, ctx);
    if (result instanceof Promise) {
      setBusy(true);
      try {
        await result;
      } finally {
        setBusy(false);
      }
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        'h-6 gap-1 px-1.5 text-xs',
        action.variant === 'destructive' && 'text-destructive hover:text-destructive',
      )}
      onClick={() => void handleClick()}
      disabled={disabled}
      title={action.label}
      aria-label={action.label}
      data-testid={`navigator-selection-action-${action.id}`}
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <span className="[&>svg]:h-3.5 [&>svg]:w-3.5">{action.icon}</span>
      )}
      <span>{action.label}</span>
    </Button>
  );
}
