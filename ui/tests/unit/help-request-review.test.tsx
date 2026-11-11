/**
 * The message review before SENDING is the same frame the receiver reviews in (ReviewShell): a list, the
 * selected item's header and viewer -- with Share / Leave out where the receiver has Install. Under a help
 * request whose context waits here, one line offers Share | Open.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ context: vi.fn(), share: vi.fn(), diagnosis: vi.fn() }));
vi.mock('@sdk', async (orig) => ({
  ...(await orig<typeof import('@sdk')>()),
  helpRequestHeld: sdk.context,
  helpRequestShare: sdk.share,
  helpRequestDiagnosis: sdk.diagnosis,
}));
import { ContentReviewDialog } from '@src/components/conversation/asset-review/ContentReviewDialog';
import { HelpRequestLine } from '@src/components/conversation/HelpRequestLine';

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

describe('HelpRequestLine', () => {
  it('offers Share for context kept here, and sends what was not left out', async () => {
    sdk.context.mockResolvedValue({ items: ITEMS, private: false });
    sdk.diagnosis.mockResolvedValue({ diagnosing: false });
    sdk.share.mockResolvedValue(['diagnosis.value.json', 'logs.txt']);
    render(<HelpRequestLine conversationId="c1" isMine />);

    fireEvent.click(await screen.findByTestId('help-request-share'));

    await waitFor(() => expect(sdk.share).toHaveBeenCalledWith('c1', []));
    await waitFor(() => expect(screen.queryByTestId('help-request-not-shared')).toBeNull());
  });

  it('a private request says its context is kept here as text, with no Share — Report it is on its diagnosis', async () => {
    sdk.context.mockResolvedValue({ items: ITEMS, private: true });
    sdk.diagnosis.mockResolvedValue({ diagnosing: true });
    render(<HelpRequestLine conversationId="c1" isMine />);

    expect(await screen.findByText('Context not shared')).toBeInTheDocument();
    expect(await screen.findByTestId('help-request-diagnosing')).toBeInTheDocument();
    expect(screen.queryByTestId('help-request-share')).toBeNull();
  });

  it('on the helper side it only names the request', () => {
    sdk.context.mockClear();
    render(<HelpRequestLine conversationId="c1" isMine={false} />);

    expect(screen.getByTestId('help-request-chip')).toBeInTheDocument();
    expect(sdk.context).not.toHaveBeenCalled();
  });
});
