import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import PersistentIframe from '@src/components/persistent-iframe';

describe('PersistentIframe ownership', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document
      .querySelectorAll('iframe[data-testid="vibe-preview"]')
      .forEach((iframe) => iframe.parentElement?.parentElement?.remove());
  });

  it('keeps a shared iframe visible when a same-URL replacement unmounts the previous owner', async () => {
    const src = 'http://persistent-iframe.test/app';
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status: 200 } as Response);

    const view = render(<PersistentIframe key="first" src={src} testId="vibe-preview" />, { wrapper });
    const iframe = await screen.findByTestId('vibe-preview');
    fireEvent.load(iframe);

    await waitFor(() => expect(iframe.parentElement).toHaveClass('opacity-100'));

    view.rerender(<PersistentIframe key="replacement" src={src} testId="vibe-preview" />);

    expect(screen.getAllByTestId('vibe-preview')).toHaveLength(1);
    await waitFor(() => expect(iframe.parentElement).toHaveClass('opacity-100'));
  });
});
