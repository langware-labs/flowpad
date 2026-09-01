import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { NavigatorSection } from '@src/components/navigator-panel/NavigatorSection';

// The unit tier has no global RTL cleanup (unlike the react tier's setup file).
afterEach(cleanup);

function Section(props: { isLoading?: boolean; itemCount: number }) {
  return (
    <NavigatorSection
      id="demo"
      label="Demo"
      isLoading={props.isLoading}
      itemCount={props.itemCount}
      emptyState={<span>nothing here</span>}
    >
      <span>a row</span>
    </NavigatorSection>
  );
}

describe('NavigatorSection', () => {
  it('opens when the data settles non-empty', async () => {
    render(<Section itemCount={3} />);
    await waitFor(() => expect(screen.getByText('a row')).toBeInTheDocument());
    expect(screen.getByTestId('navigator-section-demo')).toHaveAttribute('aria-expanded', 'true');
  });

  it('stays collapsed when the data settles empty', async () => {
    render(<Section itemCount={0} />);
    await waitFor(() => expect(screen.getByTestId('navigator-section-demo')).toHaveAttribute('aria-expanded', 'false'));
    expect(screen.queryByText('nothing here')).not.toBeInTheDocument();
  });

  it('shows the empty state once an empty section is expanded', async () => {
    render(<Section itemCount={0} />);
    await userEvent.click(screen.getByTestId('navigator-section-demo'));
    expect(screen.getByText('nothing here')).toBeInTheDocument();
  });

  // The rule fires on SETTLE, not first render: a cold cache reports 0 for a
  // frame, and deciding then would collapse every section permanently.
  it('waits for isLoading to clear before deciding', async () => {
    const { rerender } = render(<Section isLoading itemCount={0} />);
    expect(screen.getByTestId('navigator-section-demo')).toHaveAttribute('aria-expanded', 'false');

    rerender(<Section isLoading={false} itemCount={5} />);
    await waitFor(() => expect(screen.getByTestId('navigator-section-demo')).toHaveAttribute('aria-expanded', 'true'));
  });

  it('does not re-collapse when a settled section later empties', async () => {
    const { rerender } = render(<Section itemCount={2} />);
    await waitFor(() => expect(screen.getByTestId('navigator-section-demo')).toHaveAttribute('aria-expanded', 'true'));

    rerender(<Section itemCount={0} />);
    expect(screen.getByTestId('navigator-section-demo')).toHaveAttribute('aria-expanded', 'true');
  });

  it('never overrides a manual toggle', async () => {
    const { rerender } = render(<Section itemCount={2} />);
    await waitFor(() => expect(screen.getByTestId('navigator-section-demo')).toHaveAttribute('aria-expanded', 'true'));

    await userEvent.click(screen.getByTestId('navigator-section-demo'));
    expect(screen.getByTestId('navigator-section-demo')).toHaveAttribute('aria-expanded', 'false');

    rerender(<Section itemCount={7} />);
    expect(screen.getByTestId('navigator-section-demo')).toHaveAttribute('aria-expanded', 'false');
  });

  it('renders no count badge', async () => {
    render(<Section itemCount={42} />);
    await waitFor(() => expect(screen.getByText('a row')).toBeInTheDocument());
    expect(screen.queryByText('42')).not.toBeInTheDocument();
    expect(screen.queryByText('(42)')).not.toBeInTheDocument();
  });
});
