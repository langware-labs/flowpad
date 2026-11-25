/**
 * The kinds of turn a live session may run, as the person reads them: Prompts, Commands,
 * Flowpad control. The host ticks them at Approve; both sides are shown what was approved.
 */
import { useLingui } from '@lingui/react/macro';
import { useCallback } from 'react';

/** `(kinds) => "Prompts · Commands · Flowpad control"`, and one kind's own label. */
export function useTurnKindLabels(): { label: (kind: string) => string; line: (kinds: readonly string[]) => string } {
  const { t } = useLingui();
  const label = useCallback(
    (kind: string) => (kind === 'command' ? t`Commands` : kind === 'control' ? t`Flowpad control` : t`Prompts`),
    [t],
  );
  const line = useCallback((kinds: readonly string[]) => kinds.map(label).join(' · '), [label]);
  return { label, line };
}

/** One tick per kind the guest asked for. The last tick cannot be cleared: an approval runs something. */
export function TurnKindTicks({
  asked,
  ticked,
  onChange,
  disabled,
}: {
  asked: readonly string[];
  ticked: readonly string[];
  onChange: (ticked: string[]) => void;
  disabled?: boolean;
}) {
  const { label } = useTurnKindLabels();
  return (
    // The ticks sit on a clickable line: keep their clicks from opening the session.
    <span className="contents" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      {asked.map((kind) => {
        const on = ticked.includes(kind);
        return (
          <label key={kind} className="inline-flex shrink-0 items-center gap-1 text-foreground">
            <input
              type="checkbox"
              className="h-3 w-3 accent-blue-600"
              checked={on}
              disabled={disabled || (on && ticked.length === 1)}
              onChange={() => onChange(asked.filter((k) => (k === kind ? !on : ticked.includes(k))))}
              data-testid={`turn-kind-tick-${kind}`}
            />
            {label(kind)}
          </label>
        );
      })}
    </span>
  );
}
