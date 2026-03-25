import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import React, { useState } from 'react';
import { unitTestSetup } from '../utils/test-utils';

// Basic test component to verify RTL setup
function CounterComponent() {
  const [count, setCount] = useState(0);

  return (
    <div>
      <h1>Counter Test</h1>
      <p data-testid="count-display">Count: {count}</p>
      <button onClick={() => setCount(count + 1)}>Increment</button>
      <button onClick={() => setCount(count - 1)}>Decrement</button>
      <button onClick={() => setCount(0)}>Reset</button>
    </div>
  );
}

describe('React Testing Library Basic Setup', () => {
  beforeEach(async () => {
    // Reset data manager to ensure clean state between tests
    await unitTestSetup();
  });

  it('should render component correctly', () => {
    render(<CounterComponent />);

    // Test that elements are rendered
    expect(screen.getByText('Counter Test')).toBeInTheDocument();
    expect(screen.getByTestId('count-display')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Increment' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decrement' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset' })).toBeInTheDocument();
  });

  it('should update count when buttons are clicked', async () => {
    const user = userEvent.setup();
    render(<CounterComponent />);

    const countDisplay = screen.getByTestId('count-display');
    const incrementButton = screen.getByRole('button', { name: 'Increment' });
    const decrementButton = screen.getByRole('button', { name: 'Decrement' });
    const resetButton = screen.getByRole('button', { name: 'Reset' });

    // Initial state
    expect(countDisplay).toHaveTextContent('Count: 0');

    // Test increment
    await user.click(incrementButton);
    expect(countDisplay).toHaveTextContent('Count: 1');

    await user.click(incrementButton);
    await user.click(incrementButton);
    expect(countDisplay).toHaveTextContent('Count: 3');

    // Test decrement
    await user.click(decrementButton);
    expect(countDisplay).toHaveTextContent('Count: 2');

    // Test reset
    await user.click(resetButton);
    expect(countDisplay).toHaveTextContent('Count: 0');
  });

  it('should handle multiple rapid clicks', async () => {
    const user = userEvent.setup();
    render(<CounterComponent />);

    const countDisplay = screen.getByTestId('count-display');
    const incrementButton = screen.getByRole('button', { name: 'Increment' });

    // Rapid clicks
    await user.click(incrementButton);
    await user.click(incrementButton);
    await user.click(incrementButton);
    await user.click(incrementButton);
    await user.click(incrementButton);

    expect(countDisplay).toHaveTextContent('Count: 5');
  });

  it('should work with keyboard interactions', async () => {
    const user = userEvent.setup();
    render(<CounterComponent />);

    const countDisplay = screen.getByTestId('count-display');
    const incrementButton = screen.getByRole('button', { name: 'Increment' });

    // Focus and use keyboard
    incrementButton.focus();
    expect(incrementButton).toHaveFocus();

    // Press Enter to activate button
    await user.keyboard('{Enter}');
    expect(countDisplay).toHaveTextContent('Count: 1');

    // Press Space to activate button
    await user.keyboard(' ');
    expect(countDisplay).toHaveTextContent('Count: 2');
  });
});
