import React from 'react';
import { Check, Ban } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { ENTITY_COLOR_PALETTE } from '@src/lib/color-palette';
import { cn } from '@src/lib/utils';

/**
 * ColorPicker — generic, reusable swatch grid over the curated
 * contrast-tested palette (`lib/color-palette.ts`). No free hex input by
 * design: every selectable value is verified (by a vitest) to be readable
 * against both theme backgrounds, so consumers never need runtime contrast
 * logic. Pure selection — zero business logic.
 */
export interface ColorPickerProps {
  /** Currently selected hex (a palette value) or null/undefined for none. */
  value?: string | null;
  /** Fires with the swatch hex, or null when "no color" is chosen. */
  onChange: (hex: string | null) => void;
  /** Show the leading "no color" cell. Default true. */
  allowNone?: boolean;
  /** The swatches to offer. Default: the contrast-tested entity palette. A
   *  caller with its own colours (sticky notes) passes `{token, hex}` pairs. */
  palette?: readonly { token: string; hex: string }[];
  /** Swatch size: `md` (default), or `sm` for a narrow host such as a sticky note. */
  size?: 'sm' | 'md';
  className?: string;
}

export const ColorPicker: React.FC<ColorPickerProps> = ({
  value,
  onChange,
  allowNone = true,
  palette = ENTITY_COLOR_PALETTE,
  size = 'md',
  className,
}) => {
  const { t } = useLingui();
  const cell = size === 'sm' ? 'h-4 w-4' : 'h-6 w-6';
  const glyph = size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5';

  return (
    <div role="listbox" aria-label={t`Color`} className={cn('flex flex-wrap gap-1.5', className)}>
      {allowNone && (
        <button
          type="button"
          role="option"
          aria-selected={!value}
          aria-label={t`No color`}
          title={t`No color`}
          onClick={() => onChange(null)}
          className={cn(
            'flex items-center justify-center rounded-full border text-muted-foreground',
            cell,
            !value && 'ring-2 ring-ring ring-offset-1 ring-offset-background',
          )}
        >
          <Ban className={glyph} />
        </button>
      )}
      {palette.map((swatch) => (
        <button
          key={swatch.token}
          type="button"
          role="option"
          aria-selected={value === swatch.hex}
          aria-label={swatch.token}
          title={swatch.token}
          onClick={() => onChange(swatch.hex)}
          style={{ backgroundColor: swatch.hex }}
          className={cn(
            'flex items-center justify-center rounded-full',
            cell,
            value === swatch.hex && 'ring-2 ring-ring ring-offset-1 ring-offset-background',
          )}
        >
          {value === swatch.hex && (
            <Check className={cn(glyph, palette === ENTITY_COLOR_PALETTE ? 'text-white' : 'text-black/70')} />
          )}
        </button>
      ))}
    </div>
  );
};
