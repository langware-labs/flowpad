import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ refetch: vi.fn(async () => {}) }));

vi.mock('@src/hooks/use-action', () => ({
  useAction: () => ({ data: [], error: null, isLoading: false, refetch: mocks.refetch }),
}));

import { Runs } from '@src/components/assets/editor/diagnosis-request/DiagnosisRequestView';

const ID = '9697635a-a0bb-421b-9f1c-a5efca26161f';

describe('a diagnosis request runs list', () => {
  afterEach(() => {
    cleanup();
    mocks.refetch.mockClear();
  });

  // A run reaches the owner as a hub push that updates the request row (`run_count`) live; the list
  // loaded once and said "Nothing has been sent yet" until the screen was reopened.
  it('reloads when a run arrives', () => {
    const view = render(<Runs id={ID} runCount={0} />);
    expect(mocks.refetch).not.toHaveBeenCalled();

    view.rerender(<Runs id={ID} runCount={1} />);
    expect(mocks.refetch).toHaveBeenCalledTimes(1);

    view.rerender(<Runs id={ID} runCount={1} />);
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });
});
