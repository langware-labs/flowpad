/**
 * The message review before SENDING is the same frame the receiver reviews in (ReviewShell): a list, the
 * selected item's header and viewer -- with Share / Leave out where the receiver has Install.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContentReviewDialog } from '@src/components/conversation/asset-review/ContentReviewDialog';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ITEMS = [
  { name: 'diagnosis.value.json', content: '{"status":"ok","title":"Flowpad looks healthy"}' },
  { name: 'logs.txt', content: 'ERROR something' },
];

describe('ContentReviewDialog', () => {
  it('reviews what will be sent with Share / Leave out, never Install', () => {
    const onLeftOutChange = vi.fn();
    render(
      <ContentReviewDialog open onClose={() => {}} items={ITEMS} leftOut={[]} onLeftOutChange={onLeftOutChange} onShare={() => {}} />,
    );

    expect(screen.getByText('Context to share — review before sending.')).toBeInTheDocument();
    expect(screen.getByTestId('content-review-row-logs.txt')).toBeInTheDocument();
    expect(screen.getByTestId('content-review-body').textContent).toContain('"title": "Flowpad looks healthy"');
    expect(screen.queryByTestId('asset-install-project')).toBeNull();

    fireEvent.click(screen.getByTestId('content-review-leave-out'));
    expect(onLeftOutChange).toHaveBeenCalledWith(['diagnosis.value.json']);
  });
});
