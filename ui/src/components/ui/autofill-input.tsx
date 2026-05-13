import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import type { ComponentProps, FocusEvent } from 'react';
import { Input } from './input';

export interface AutofillInputProps extends Omit<ComponentProps<'input'>, 'value' | 'onChange' | 'defaultValue'> {
  /** Suggested text shown when the user hasn't typed yet. */
  autofill: string;
  /** Current user-typed value. Empty string means "not dirty yet". */
  value: string;
  /** Fires on every keystroke; first non-empty value flips the input into dirty mode. */
  onChange: (next: string) => void;
}

export const AutofillInput = forwardRef<HTMLInputElement, AutofillInputProps>(
  ({ autofill, value, onChange, onFocus, ...rest }, ref) => {
    const inputRef = useRef<HTMLInputElement>(null);
    useImperativeHandle(ref, () => inputRef.current as HTMLInputElement);

    // Pristine = user hasn't typed yet. We show `autofill` as the input's
    // displayed text but keep `value` (the parent's source of truth) empty so
    // the caller can detect "untouched" and substitute the autofill at submit.
    const [pristine, setPristine] = useState(true);
    const displayValue = pristine ? autofill : value;

    const handleFocus = (e: FocusEvent<HTMLInputElement>) => {
      onFocus?.(e);
      if (pristine) {
        // Select all so typing replaces the autofill in one stroke.
        e.target.select();
      }
    };

    return (
      <Input
        ref={inputRef}
        value={displayValue}
        onFocus={handleFocus}
        onChange={(e) => {
          const next = e.target.value;
          if (pristine) setPristine(false);
          // If the user erases everything we still treat the input as dirty —
          // they explicitly chose an empty title and shouldn't see the
          // autofill come back.
          onChange(next);
        }}
        {...rest}
      />
    );
  },
);
AutofillInput.displayName = 'AutofillInput';
