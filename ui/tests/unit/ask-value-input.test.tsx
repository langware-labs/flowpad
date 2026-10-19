/** The value field every ask surface draws: a line, or — for a key file — a picker whose content is the answer. */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AskValueInput } from '@src/components/ask/AskValueInput';

afterEach(cleanup);

describe('AskValueInput', () => {
  it('a secret line is masked', () => {
    render(<AskValueInput id="a" testId="v" secret value="" onChange={() => undefined} onEnter={() => undefined} />);
    expect(screen.getByTestId('v')).toHaveAttribute('type', 'password');
  });

  it('a picked file answers with its content, and shows only its name', async () => {
    const onChange = vi.fn();
    render(<AskValueInput id="a" testId="v" secret file value="" onChange={onChange} onEnter={() => undefined} />);

    const key = new File(['{"type": "service_account"}'], 'key.json', { type: 'application/json' });
    fireEvent.change(screen.getByTestId('v'), { target: { files: [key] } });

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('{"type": "service_account"}'));
    expect(screen.getByTestId('v-picked')).toHaveTextContent('key.json');
    expect(screen.queryByText(/service_account/)).toBeNull();
  });

  it('can be pasted instead', () => {
    const onChange = vi.fn();
    render(<AskValueInput id="a" testId="v" secret file value="" onChange={onChange} onEnter={() => undefined} />);

    fireEvent.click(screen.getByTestId('v-paste'));
    fireEvent.change(screen.getByTestId('v-text'), { target: { value: '{"x": 1}' } });

    expect(onChange).toHaveBeenCalledWith('{"x": 1}');
  });
});
