import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ColorPicker } from '@src/components/ui/color-picker';
import { ENTITY_COLOR_PALETTE } from '@src/lib/color-palette';

describe('ColorPicker (generic, curated palette)', () => {
  it('renders every curated swatch plus the no-color option', () => {
    render(<ColorPicker value={null} onChange={() => undefined} />);
    for (const swatch of ENTITY_COLOR_PALETTE) {
      expect(screen.getByRole('option', { name: swatch.token })).toBeTruthy();
    }
    expect(screen.getByRole('option', { name: 'No color' })).toBeTruthy();
  });

  it('selecting a swatch fires onChange with its palette hex', async () => {
    const onChange = vi.fn();
    render(<ColorPicker value={null} onChange={onChange} />);
    await userEvent.click(screen.getByRole('option', { name: 'blue' }));
    const blue = ENTITY_COLOR_PALETTE.find((s) => s.token === 'blue')!;
    expect(onChange).toHaveBeenCalledWith(blue.hex);
  });

  it('the no-color option fires onChange(null) and selection is reflected', async () => {
    const onChange = vi.fn();
    const blue = ENTITY_COLOR_PALETTE.find((s) => s.token === 'blue')!;
    render(<ColorPicker value={blue.hex} onChange={onChange} />);
    expect(screen.getByRole('option', { name: 'blue' }).getAttribute('aria-selected')).toBe('true');
    await userEvent.click(screen.getByRole('option', { name: 'No color' }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
