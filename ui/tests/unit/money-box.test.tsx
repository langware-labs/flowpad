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
 * NO ceiling. Handing out more than the pool above still holds is a state the hub supports, not a
 * mistake: every hop's cap is checked when the money is SPENT (`core/llm/limits.check_path` walks
 * entry -> root and refuses at the first used-up hop), so a $10 team pot pays out $10 however the
 * shares inside it are written. Ten members may each hold $10 of it. The budgets page says exactly
 * this in its over-allocation banner -- so a box that refused to CREATE the state was contradicting
 * the banner that explains the state is fine.
 */
describe('MoneyBox — more than the pool holds', () => {
  it('commits an amount larger than the pool above it has left', () => {
    const onCommit = vi.fn();
    render(<MoneyBox value={10} onCommit={onCommit} ariaLabel="Budget" data-testid="money" />);
    const input = screen.getByTestId<HTMLInputElement>('money');

    fireEvent.change(input, { target: { value: '90' } });
    fireEvent.blur(input);

    expect(onCommit).toHaveBeenCalledWith(90);
  });

  it('commits blank — an uncapped member is still bounded by the pool when the money is spent', () => {
    const onCommit = vi.fn();
    render(<MoneyBox value={10} onCommit={onCommit} ariaLabel="Budget" data-testid="money" />);
    const input = screen.getByTestId<HTMLInputElement>('money');

    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);

    expect(onCommit).toHaveBeenCalledWith(null);
  });
});
