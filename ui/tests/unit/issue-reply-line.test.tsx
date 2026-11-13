/**
 * A Monitoring message's issue line: title, status, count, the fix (opens its pointer), and the manual moves,
 * which reach the hub's `issue/<id>/status` through the SDK. Only the transport (`callAction`) and the dock
 * navigation are stubbed.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataManager, issueReplyOf, type IssueReplyMeta } from '@sdk';

const h = vi.hoisted(() => ({ openDockOnThisPage: vi.fn() }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDockOnThisPage: h.openDockOnThisPage } }),
}));

const { IssueReplyLine } = await import('@src/components/conversation/IssueReplyLine');

const ISSUE_ID = '550e8400-e29b-41d4-a716-446655440000';

function reply(over: Partial<IssueReplyMeta> = {}): IssueReplyMeta {
  return issueReplyOf({
    issue: {
      issue_typeid: `issue-${ISSUE_ID}`,
      kind: 'budget_exhausted',
      severity: 'error',
      status: 'open',
      count: 3,
      title: 'Token limit reached',
      detail: '',
      fix: { label: 'Refill', pointer: '/dock/hub/home' },
      subject_typeid: 'deployment-x',
      ...over,
    },
  }) as IssueReplyMeta;
}

describe('IssueReplyLine', () => {
  let calls: Array<{ action: string; id: string | null; body: unknown }>;
  beforeEach(() => {
    calls = [];
    h.openDockOnThisPage.mockClear();
    // eslint-disable-next-line @typescript-eslint/require-await -- the mock stands in for an async action
    vi.spyOn(dataManager, 'callAction').mockImplementation(async (info) => {
      calls.push({ action: info.name, id: info.targetEntity?.toString() ?? null, body: info.bodyParameters });
      return {} as never;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows the title, status and count', () => {
    render(<IssueReplyLine reply={reply()} />);
    expect(screen.getByTestId('issue-reply-title').textContent).toBe('Token limit reached');
    expect(screen.getByTestId('issue-reply-status').textContent).toBe('Open');
    expect(screen.getByTestId('issue-reply-count').textContent).toBe('×3');
  });

  it('hides the count for a single occurrence', () => {
    render(<IssueReplyLine reply={reply({ count: 1, status: 'seen' })} />);
    expect(screen.queryByTestId('issue-reply-count')).toBeNull();
    expect(screen.getByTestId('issue-reply-status').textContent).toBe('Seen');
  });

  it('the fix button opens the fix pointer', async () => {
    render(<IssueReplyLine reply={reply()} />);
    fireEvent.click(screen.getByTestId('issue-reply-fix'));
    await waitFor(() => expect(h.openDockOnThisPage).toHaveBeenCalledTimes(1));
    expect(h.openDockOnThisPage.mock.calls[0][0]).toBeTruthy();
  });

  it('Mark in progress sets the status on the hub', async () => {
    render(<IssueReplyLine reply={reply()} />);
    fireEvent.click(screen.getByTestId('issue-reply-in-progress'));
    await waitFor(() => expect(screen.getByTestId('issue-reply-status').textContent).toBe('In progress'));
    expect(calls).toEqual([{ action: 'status', id: `issue-${ISSUE_ID}`, body: { status: 'in_progress' } }]);
    expect(screen.queryByTestId('issue-reply-in-progress')).toBeNull();
  });

  it('Close sets closed; a closed issue offers Reopen', async () => {
    render(<IssueReplyLine reply={reply()} />);
    fireEvent.click(screen.getByTestId('issue-reply-close'));
    await waitFor(() => expect(screen.getByTestId('issue-reply-status').textContent).toBe('Closed'));
    expect(screen.queryByTestId('issue-reply-fix')).toBeNull();
    fireEvent.click(screen.getByTestId('issue-reply-reopen'));
    await waitFor(() => expect(screen.getByTestId('issue-reply-status').textContent).toBe('Open'));
    expect(calls.map((c) => c.body)).toEqual([{ status: 'closed' }, { status: 'open' }]);
  });

  it('follows the status the hub writes onto the message', () => {
    const { rerender } = render(<IssueReplyLine reply={reply()} />);
    rerender(<IssueReplyLine reply={reply({ status: 'resolved' })} />);
    expect(screen.getByTestId('issue-reply-status').textContent).toBe('Resolved');
    expect(screen.queryByTestId('issue-reply-close')).toBeNull();
  });

  it('the card says what happened, whose machine, the cause and how it stands; a row opens the issue page', () => {
    render(
      <IssueReplyLine
        reply={reply({
          kind: 'deployment_unreachable',
          severity: 'warning',
          status: 'resolved',
          detail: "Flowpad couldn't ask the provider about the machine.",
          machine: 'visitor 8f99',
          cause: 'connection reset',
          opened_at: 1_800_000_000,
          resolved_at: 1_800_000_050,
        } as Partial<IssueReplyMeta>)}
      />,
    );
    expect(screen.getByTestId('issue-card-row-what').textContent).toContain("couldn't ask the provider");
    expect(screen.getByTestId('issue-card-row-machine').textContent).toContain('visitor 8f99');
    expect(screen.getByTestId('issue-card-row-cause').textContent).toContain('connection reset');
    expect(screen.getByTestId('issue-card-row-status').textContent).toContain('Resolved by itself after 50s');

    fireEvent.click(screen.getByTestId('issue-card-row-cause'));
    expect(h.openDockOnThisPage).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.openDockOnThisPage.mock.calls[0][0])).toContain(`issue/${ISSUE_ID}`);
  });
});

describe('issueReplyOf', () => {
  it('reads only a metadata.issue that names its issue', () => {
    expect(issueReplyOf({ issue: { title: 'x' } })).toBeNull();
    expect(issueReplyOf(null)).toBeNull();
    expect(reply({ status: 'bogus' as never }).status).toBe('open');
  });
});
