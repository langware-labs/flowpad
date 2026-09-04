/**
 * `MoneyBox` — the editable dollar box shared by org, team and person rows.
 *
 * The behaviour worth locking: it commits on blur/Enter and NOT per keystroke (a half-typed "5"
 * on the way to "50" must never fire), Escape reverts to the last committed value, blank means
 * uncapped (not zero — those are different states: "no cap" vs "no money at all"), and a
 * non-numeric or negative entry is rejected without calling `onCommit`.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MoneyBox } from '@src/components/organization/budgets/MoneyBox';

afterEach(cleanup);

function box(value: number | null, onCommit: (usd: number | null) => void) {
  return render(<MoneyBox value={value} onCommit={onCommit} ariaLabel="Budget" data-testid="money" />);
}

describe('MoneyBox', () => {
  it('does not commit while typing — only on blur', () => {
    const onCommit = vi.fn();
    box(null, onCommit);
    const input = screen.getByTestId<HTMLInputElement>('money');

    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.change(input, { target: { value: '50' } });
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(50);
  });

  it('commits on Enter, by blurring the (focused) input rather than committing directly', () => {
    // `.currentTarget.blur()` only fires a real blur event in jsdom when the element is the one
    // actually focused — matching a real browser, where Enter is pressed while the box has focus.
    const onCommit = vi.fn();
    box(null, onCommit);
    const input = screen.getByTestId<HTMLInputElement>('money');

    input.focus(); // the native DOM call — this is what actually moves `document.activeElement`
    // in jsdom; `fireEvent.focus` only dispatches the event and does not.
    fireEvent.change(input, { target: { value: '25' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith(25);
  });

  it('reverts to the last committed value on Escape, and commits nothing', () => {
    const onCommit = vi.fn();
    box(10, onCommit);
    const input = screen.getByTestId<HTMLInputElement>('money');

    fireEvent.change(input, { target: { value: '999' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('10');

    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('treats a blank box as uncapped, not as zero', () => {
    const onCommit = vi.fn();
    box(10, onCommit);
    const input = screen.getByTestId<HTMLInputElement>('money');

    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it('rejects a non-numeric entry without calling onCommit, and shows a problem', () => {
    const onCommit = vi.fn();
    box(10, onCommit);
    const input = screen.getByTestId<HTMLInputElement>('money');

    fireEvent.change(input, { target: { value: 'ten dollars' } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByText(/must be a number/i)).toBeTruthy();
  });

  it('rejects a negative amount', () => {
    const onCommit = vi.fn();
    box(10, onCommit);
    const input = screen.getByTestId<HTMLInputElement>('money');

    fireEvent.change(input, { target: { value: '-5' } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('does not commit when the value did not actually change', () => {
    const onCommit = vi.fn();
    box(10, onCommit);
    const input = screen.getByTestId<HTMLInputElement>('money');

    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("re-syncs its displayed value when the prop changes underneath it (a refetch after someone else's edit)", () => {
    const onCommit = vi.fn();
    const { rerender } = box(10, onCommit);
    const input = screen.getByTestId<HTMLInputElement>('money');
    expect(input.value).toBe('10');

    rerender(<MoneyBox value={40} onCommit={onCommit} ariaLabel="Budget" data-testid="money" />);
    expect(screen.getByTestId<HTMLInputElement>('money').value).toBe('40');
  });
});

/**
 * The ceiling. `available` is what the pool above this box still has free; an amount larger than
 * that is refused in the box rather than sent to the hub and refused there — or, worse, accepted
 * there and discovered weeks later as a worker that stopped.
 */
describe('MoneyBox — more than is left', () => {
  function capped(value: number | null, onCommit: (usd: number | null) => void, available: number | null = 60) {
    return render(
      <MoneyBox
        value={value}
        onCommit={onCommit}
        ariaLabel="Budget"
        data-testid="money"
        available={available}
        availableFrom="Langware"
      />,
    );
  }

  it('refuses an amount larger than what is left, and does not commit it', () => {
    const onCommit = vi.fn();
    capped(10, onCommit);
    const input = screen.getByTestId<HTMLInputElement>('money');

    fireEvent.change(input, { target: { value: '90' } });
    fireEvent.blur(input);

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByTestId('money-box-over')).toBeTruthy();
  });

  it('keeps what was typed so it can be corrected rather than retyped', () => {
    capped(10, vi.fn());
    const input = screen.getByTestId<HTMLInputElement>('money');

    fireEvent.change(input, { target: { value: '90' } });
    fireEvent.blur(input);

    expect(input.value).toBe('90');
  });

  it('commits the exact remainder — the ceiling is inclusive', () => {
    const onCommit = vi.fn();
    capped(10, onCommit);
    const input = screen.getByTestId<HTMLInputElement>('money');

    fireEvent.change(input, { target: { value: '60' } });
    fireEvent.blur(input);

    expect(onCommit).toHaveBeenCalledWith(60);
    expect(screen.queryByTestId('money-box-over')).toBeNull();
  });

  it('refuses blank — under a real ceiling, "unlimited" is more than whatever is left', () => {
    const onCommit = vi.fn();
    capped(10, onCommit);
    const input = screen.getByTestId<HTMLInputElement>('money');

    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByTestId('money-box-over')).toBeTruthy();
  });

  it('clears the refusal as soon as the next character is typed', () => {
    capped(10, vi.fn());
    const input = screen.getByTestId<HTMLInputElement>('money');

    fireEvent.change(input, { target: { value: '90' } });
    fireEvent.blur(input);
    expect(screen.getByTestId('money-box-over')).toBeTruthy();

    fireEvent.change(input, { target: { value: '9' } });
    expect(screen.queryByTestId('money-box-over')).toBeNull();
  });

  it('never refuses a row that ALREADY exceeds its pool, so it stays editable', () => {
    // The hub permits an over-promise and older data has it. If merely focusing and leaving such a
    // row reported an error, the person could not even lower it back into range.
    const onCommit = vi.fn();
    capped(500, onCommit);
    const input = screen.getByTestId<HTMLInputElement>('money');

    fireEvent.blur(input);
    expect(screen.queryByTestId('money-box-over')).toBeNull();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('applies no ceiling at all when the pool above is uncapped', () => {
    const onCommit = vi.fn();
    capped(10, onCommit, null);
    const input = screen.getByTestId<HTMLInputElement>('money');

    fireEvent.change(input, { target: { value: '99999' } });
    fireEvent.blur(input);

    expect(onCommit).toHaveBeenCalledWith(99999);
  });
});
