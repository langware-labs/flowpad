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
 *
 * **`available` refuses an amount larger than the pool above it has left.** The refusal happens at
 * commit, not per keystroke, for the same reason the save does: someone typing "100" passes through
 * "1" and "10", and rejecting those mid-word would fight the person instead of helping them. What
 * is refused is held in the box so it can be corrected rather than retyped — the value is never
 * silently replaced with one they did not choose. See `available-to-allocate.ts` for why this is a
 * UI courtesy and not a security control.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';

import { Input } from '@src/components/ui/input';

import { allocationProblem, type AllocationProblem } from './available-to-allocate';

export interface MoneyBoxProps {
  /** Current cap in USD; `null` = uncapped. */
  value: number | null;
  /** Called only when the value actually changed and parses. */
  onCommit: (usd: number | null) => void;
  disabled?: boolean;
  'data-testid'?: string;
  ariaLabel: string;
  /**
   * The most this box may commit, in USD — what the pool above it still has free. `null` or
   * omitted means there is no ceiling to check (an uncapped pool), and every amount commits.
   */
  available?: number | null;
  /** What the ceiling is called in the refusal, e.g. the team or organization name. */
  availableFrom?: string;
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

export function MoneyBox({
  value,
  onCommit,
  disabled,
  ariaLabel,
  available = null,
  availableFrom,
  ...rest
}: MoneyBoxProps) {
  const { t } = useLingui();
  const [draft, setDraft] = useState(() => toText(value));
  const [bad, setBad] = useState(false);
  const [tooMuch, setTooMuch] = useState<AllocationProblem | undefined>(undefined);

  // Re-sync when the row's value changes underneath (a refetch after someone else's edit). Editing
  // is short-lived and commit-based, so there is no in-flight keystroke to clobber.
  useEffect(() => {
    setDraft(toText(value));
    setBad(false);
    setTooMuch(undefined);
  }, [value]);

  const clear = () => {
    setBad(false);
    setTooMuch(undefined);
  };

  const commit = () => {
    const parsed = parseMoney(draft);
    if (parsed === undefined) {
      setBad(true);
      setTooMuch(undefined);
      return;
    }
    // An unchanged value is never refused: a row already sitting above its pool's remainder (the
    // hub permits that, and older data has it) must stay editable — otherwise merely focusing and
    // leaving it would report an error about a number nobody just typed.
    if (parsed === value) {
      clear();
      return;
    }
    const problem = allocationProblem(parsed, available);
    if (problem) {
      setBad(false);
      setTooMuch(problem);
      return;
    }
    clear();
    onCommit(parsed);
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
          className={`h-7 w-24 text-end ${bad || tooMuch ? 'border-destructive' : ''}`}
          placeholder={t`unlimited`}
          value={draft}
          disabled={disabled}
          onChange={(e) => {
            setDraft(e.target.value);
            setTooMuch(undefined);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur();
            }
            if (e.key === 'Escape') {
              setDraft(toText(value));
              clear();
            }
          }}
        />
      </span>
      {bad && (
        <span className="text-[11px] text-destructive">
          <Trans>Must be a number, or blank for no limit.</Trans>
        </span>
      )}
      {tooMuch && (
        <span className="text-[11px] text-destructive" data-testid="money-box-over">
          {tooMuch === 'unlimited-under-cap' ? (
            availableFrom ? (
              <Trans>{availableFrom} has a limit, so this cannot be unlimited.</Trans>
            ) : (
              <Trans>This cannot be unlimited — the budget it draws on has a limit.</Trans>
            )
          ) : availableFrom ? (
            <Trans>
              Only ${available} left in {availableFrom}.
            </Trans>
          ) : (
            <Trans>Only ${available} left to give out.</Trans>
          )}
        </span>
      )}
    </span>
  );
}
