/**
 * Every tab chip's hover card leads with the tab's name and a button that
 * copies it — the name is often truncated on the chip, and the card is where
 * the user reads it in full.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TabTooltipName } from '@src/components/tabs/TabTooltipName';

const copyToClipboard = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sdk')>()),
  copyToClipboard,
}));

afterEach(cleanup);

describe('TabTooltipName', () => {
  it('copies the tab name and does not bubble the click to the chip', () => {
    const onChipClick = vi.fn();
    render(
      <div onClick={onChipClick}>
        <TabTooltipName name="gtm-weekly-tracker.html" />
      </div>,
    );

    expect(screen.getByTestId('tab-tooltip-name').textContent).toBe('gtm-weekly-tracker.html');
    fireEvent.click(screen.getByTestId('tab-tooltip-copy-name'));

    expect(copyToClipboard).toHaveBeenCalledWith('gtm-weekly-tracker.html');
    expect(onChipClick).not.toHaveBeenCalled();
  });
});
