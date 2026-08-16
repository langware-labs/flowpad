import { Checkbox } from '@src/components/ui/checkbox';

interface Props {
  /** "Include system" rides a separate boolean from the scope filter (the
   *  unified ScopeFilter shape is `{user, projects}`; system can't fold into it
   *  without a schema change). Owned by the navigator. */
  includeSystem: boolean;
  onIncludeSystemChange: (next: boolean) => void;
  /** How many system triggers are currently hidden (0 when included). */
  hiddenSystemCount: number;
}

/**
 * Triggers navigator sub-filter row — the "Include system" toggle that sits in
 * `NavigatorPanel`'s `header.filterBar` (the row under the title). The canonical
 * scope filter (All/User/Project/Selected) lives in the title row itself
 * (`header.headerRight`), shared with every other navigator.
 */
export function TriggersFilterBar({ includeSystem, onIncludeSystemChange, hiddenSystemCount }: Props) {
  return (
    <div className="flex items-center gap-1.5">
      <Checkbox
        id="triggers-include-system"
        checked={includeSystem}
        onCheckedChange={(v) => onIncludeSystemChange(v === true)}
        className="h-3 w-3"
      />
      <label htmlFor="triggers-include-system" className="cursor-pointer select-none text-[10px] text-muted-foreground">
        Include system
        {hiddenSystemCount > 0 && <span className="ms-1 text-muted-foreground/60">({hiddenSystemCount})</span>}
      </label>
    </div>
  );
}
