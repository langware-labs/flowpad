import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import React from 'react';
import { MockDataManagerComponent, MockAPIComponent } from '../utils/react';
import { unitTestSetup } from '../utils/test-utils';

describe('React Basics - Data Manager Integration', () => {
  beforeEach(async () => {
    // Reset data manager to ensure clean state between tests
    await unitTestSetup();
  });

  it('should render data manager component', async () => {
    render(<MockDataManagerComponent />);

    // Should render basic elements
    expect(screen.getByTestId('loading-status')).toHaveTextContent('Ready');
    expect(screen.getByTestId('pages-count')).toHaveTextContent('Pages: 0');
    expect(screen.getByTestId('load-pages-button')).toBeInTheDocument();
    expect(screen.getByTestId('create-page-button')).toBeInTheDocument();
    expect(screen.getByTestId('clear-cache-button')).toBeInTheDocument();
  });

  it('should handle cache clearing', async () => {
    const user = userEvent.setup();

    render(<MockDataManagerComponent />);

    // Test clear cache button functionality
    const clearButton = screen.getByTestId('clear-cache-button');
    await user.click(clearButton);

    // Should remain at 0 pages (no-op since there were no pages to begin with)
    expect(screen.getByTestId('pages-count')).toHaveTextContent('Pages: 0');
  });
});

describe('React Basics - API Integration', () => {
  it('should handle successful API calls', async () => {
    const user = userEvent.setup();
    const mockOnAPIResult = vi.fn();

    render(<MockAPIComponent onAPIResult={mockOnAPIResult} />);

    // Initially should be idle
    expect(screen.getByTestId('api-status')).toHaveTextContent('idle');

    // Fetch users
    const fetchUsersButton = screen.getByTestId('fetch-users-button');
    await user.click(fetchUsersButton);

    // Should show loading
    expect(screen.getByTestId('api-status')).toHaveTextContent('loading');

    // Wait for success
    await waitFor(() => {
      expect(screen.getByTestId('api-status')).toHaveTextContent('success');
    });

    // Should show response
    expect(screen.getByTestId('response-status')).toHaveTextContent('success');
    expect(screen.getByTestId('response-list')).toBeInTheDocument();

    // Should have called the callback
    expect(mockOnAPIResult).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'success',
        data: expect.arrayContaining([expect.objectContaining({ id: 1, name: 'John Doe' })]),
      }),
    );
  });

  it('should handle API errors gracefully', async () => {
    const user = userEvent.setup();

    render(<MockAPIComponent />);

    // Trigger error
    const errorButton = screen.getByTestId('trigger-error-button');
    await user.click(errorButton);

    // Should show loading
    expect(screen.getByTestId('api-status')).toHaveTextContent('loading');

    // Wait for error
    await waitFor(() => {
      expect(screen.getByTestId('api-status')).toHaveTextContent('error');
    });

    // Should show error message
    expect(screen.getByTestId('error-message')).toHaveTextContent('Simulated API error');
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('should handle different API endpoints', async () => {
    const user = userEvent.setup();

    render(<MockAPIComponent />);

    // Test pages endpoint
    const fetchPagesButton = screen.getByTestId('fetch-pages-button');
    await user.click(fetchPagesButton);

    await waitFor(() => {
      expect(screen.getByTestId('api-status')).toHaveTextContent('success');
    });

    const responseList = screen.getByTestId('response-list');
    expect(responseList).toHaveTextContent('Home Page');
    expect(responseList).toHaveTextContent('About Page');

    // Test reset functionality
    const resetButton = screen.getByTestId('reset-button');
    await user.click(resetButton);

    expect(screen.getByTestId('api-status')).toHaveTextContent('idle');
    expect(screen.queryByTestId('api-response')).not.toBeInTheDocument();
  });

  it('should handle multiple sequential API calls', async () => {
    const user = userEvent.setup();

    render(<MockAPIComponent />);

    // Make multiple calls
    const fetchUsersButton = screen.getByTestId('fetch-users-button');
    const fetchPagesButton = screen.getByTestId('fetch-pages-button');

    // First call
    await user.click(fetchUsersButton);
    await waitFor(() => {
      expect(screen.getByTestId('api-status')).toHaveTextContent('success');
    });
    expect(screen.getByTestId('response-list')).toHaveTextContent('John Doe');

    // Second call
    await user.click(fetchPagesButton);
    await waitFor(() => {
      expect(screen.getByTestId('api-status')).toHaveTextContent('success');
    });
    expect(screen.getByTestId('response-list')).toHaveTextContent('Home Page');
  });
});
