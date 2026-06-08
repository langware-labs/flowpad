import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { IconPicker, ICON_PICKER_EMOJI } from '@src/components/ui/icon-picker';
import { isLucideName } from '@src/lib/icon-value';

describe('IconPicker (generic, lucide + emoji tabs)', () => {
  it('lucide tab: search narrows the grid; selection fires the export name', async () => {
    const onChange = vi.fn();
    render(<IconPicker value={null} onChange={onChange} />);
    await userEvent.type(screen.getByLabelText('Search icons'), 'rocket');
    const rocket = screen.getByRole('option', { name: 'Rocket' });
    await userEvent.click(rocket);
    expect(onChange).toHaveBeenCalledWith('Rocket');
    expect(isLucideName('Rocket')).toBe(true);
  });

  it('emoji tab: selection fires the character (non-lucide value)', async () => {
    const onChange = vi.fn();
    render(<IconPicker value={null} onChange={onChange} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Emoji' }));
    const emoji = ICON_PICKER_EMOJI[0];
    await userEvent.click(screen.getByRole('option', { name: emoji }));
    expect(onChange).toHaveBeenCalledWith(emoji);
    expect(isLucideName(emoji)).toBe(false);
  });

  it('clicking the selected value clears it (toggle off)', async () => {
    const onChange = vi.fn();
    render(<IconPicker value="Rocket" onChange={onChange} />);
    await userEvent.type(screen.getByLabelText('Search icons'), 'rocket');
    await userEvent.click(screen.getByRole('option', { name: 'Rocket' }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
