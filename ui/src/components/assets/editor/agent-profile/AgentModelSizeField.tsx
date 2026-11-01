import { WorkerModelTier } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';

/** The select's "nothing chosen" value: Radix reserves the empty string for "no selection". */
const DEFAULT_SIZE = '__default';

/**
 * Which model size the agent needs. Unset means "work with whatever the person's budget gives" — the
 * agent never conflicts. A size makes the agent ask for it: a budget that does not offer that size is
 * refused in words when the agent starts, rather than silently answered by a different model.
 *
 * A value that is not one of the three sizes (a model named by hand in `agent.json`) stays
 * representable: it is listed as itself instead of being rewritten on the next save.
 */
export function AgentModelSizeField({
  value,
  onCommit,
}: {
  value?: string | null;
  onCommit: (value: string | undefined) => void;
}) {
  const { t } = useLingui();
  const sizes = [
    { value: WorkerModelTier.SM, label: t`Fast` },
    { value: WorkerModelTier.MD, label: t`Balanced` },
    { value: WorkerModelTier.LG, label: t`Accurate` },
  ];
  const current = value || DEFAULT_SIZE;
  const isCustom = current !== DEFAULT_SIZE && !sizes.some((size) => String(size.value) === current);

  return (
    <div className="rounded-md border border-border px-3 py-2" data-testid="agent-model-size">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm">
          <Trans>Model size</Trans>
        </span>
        <Select value={current} onValueChange={(next) => onCommit(next === DEFAULT_SIZE ? undefined : next)}>
          <SelectTrigger aria-label={t`Model size`} className="h-8 w-auto min-w-[9rem] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value={DEFAULT_SIZE} data-testid="agent-model-size-default">
              {t`Whatever I get`}
            </SelectItem>
            {sizes.map((size) => (
              <SelectItem key={size.value} value={size.value} data-testid={`agent-model-size-${size.value}`}>
                {size.label}
              </SelectItem>
            ))}
            {isCustom ? <SelectItem value={current}>{current}</SelectItem> : null}
          </SelectContent>
        </Select>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        <Trans>
          Left alone, the agent works with whatever model your budget gives it. Pick a size to require it: if your
          budget does not offer that size, the agent will not start and tells you why.
        </Trans>
      </p>
    </div>
  );
}
