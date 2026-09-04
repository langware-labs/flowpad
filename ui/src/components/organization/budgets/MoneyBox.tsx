/**
 * The editable dollar box — one number, committed on blur or Enter, reverted on Escape.
 *
 * Held as a STRING while it is being typed, the way `LimitsEditor` holds its limits: binding a
 * number directly makes an empty box read as 0, and 0 is not "no cap", it is "no money at all" (the
 * hub reports that state as *no budget allocated* rather than as an exhausted one). Blank means
 * uncapped, and that distinction has to survive the keystroke where the field is momentarily empty.
 *
 * It commits rather than saving per keystroke because each save is a hub write, and because a
 * half-typed "5" on the way to "50" is a real cap the person did not mean.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';

import { Input } from '@src/components/ui/input';

export interface MoneyBoxProps {
  /** Current cap in USD; `null` = uncapped. */
  value: number | null;
  /** Called only when the value actually changed and parses. */
  onCommit: (usd: number | null) => void;
  disabled?: boolean;
  'data-testid'?: string;
  ariaLabel: string;
}

function toText(value: number | null): string {
  return value === null || value === undefined ? '' : String(value);
}

/** `''` → null (uncapped); a non-negative number → itself; anything else → `undefined` (reject). */
export function parseMoney(raw: string): number | null | undefined {
  const trimmed = raw.trim().replace(/[$,\s]/g, '');
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value;
}

export function MoneyBox({ value, onCommit, disabled, ariaLabel, ...rest }: MoneyBoxProps) {
  const { t } = useLingui();
  const [draft, setDraft] = useState(() => toText(value));
  const [bad, setBad] = useState(false);

  // Re-sync when the row's value changes underneath (a refetch after someone else's edit). Editing
  // is short-lived and commit-based, so there is no in-flight keystroke to clobber.
  useEffect(() => {
    setDraft(toText(value));
    setBad(false);
  }, [value]);

  const commit = () => {
    const parsed = parseMoney(draft);
    if (parsed === undefined) {
      setBad(true);
      return;
    }
    setBad(false);
    if (parsed !== value) onCommit(parsed);
  };

  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <span className="inline-flex items-center gap-1">
        <span className="text-muted-foreground">$</span>
        <Input
          type="text"
          inputMode="decimal"
          aria-label={ariaLabel}
          data-testid={rest['data-testid']}
          className={`h-7 w-24 text-end ${bad ? 'border-destructive' : ''}`}
          placeholder={t`unlimited`}
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur();
            }
            if (e.key === 'Escape') {
              setDraft(toText(value));
              setBad(false);
            }
          }}
        />
      </span>
      {bad && (
        <span className="text-[11px] text-destructive">
          <Trans>Must be a number, or blank for no limit.</Trans>
        </span>
      )}
    </span>
  );
}
