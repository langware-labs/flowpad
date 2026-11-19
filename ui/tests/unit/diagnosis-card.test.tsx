/**
 * A help request and its diagnosis are one card: a status chip, the issue and the root cause in a line each,
 * and only the actions that apply -- Fix when the diagnosis can apply its fix here, Ask for help, Done.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ diagnosis: vi.fn(), held: vi.fn(), report: vi.fn(), fix: vi.fn(), archive: vi.fn() }));
vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => ({ navigation: { openShellProcess: vi.fn() }, currentDock: null }) }));
vi.mock('@sdk', async (orig) => ({
  ...(await orig<typeof import('@sdk')>()),
  helpRequestDiagnosis: sdk.diagnosis,
  helpRequestHeld: sdk.held,
  helpRequestReport: sdk.report,
  helpRequestFix: sdk.fix,
  archiveConversation: sdk.archive,
}));
import { DiagnosisCard } from '@src/components/conversation/DiagnosisCard';
import { useDiagnosisLinks } from '@src/notifications/alerts-store';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const answer = (over: Record<string, unknown> = {}, diagnosis: Record<string, unknown> = {}) => ({
  state: 'open',
  issue: '1 project without a folder',
  request: '1 project without a folder\nTheir folders were deleted or moved.',
  diagnosing: false,
  diagnosis: { status: 'needs_action', cause: 'project', cause_asset: '', title: 'The folder of demo was deleted', summary: 's', rca: 'Its path is gone.', fix: 'Remove the entry.', local_fix: false, bug: null, findings: [], ...diagnosis },
  reportable: false,
  reported: false,
  desk: 'Flowpad support',
  pass_on: '',
  worker_process_id: 'p1',
  worker_process_name: 'flow diagnose · 1 project',
  ...over,
});

describe('DiagnosisCard', () => {
  it('says the status, the issue and the root cause, and folds the rest', async () => {
    sdk.held.mockResolvedValue({ items: [], private: true });
    sdk.diagnosis.mockResolvedValue(answer());
    render(<DiagnosisCard conversationId="c1" isMine />);

    expect(await screen.findByTestId('diagnosis-status')).toHaveTextContent('Open');
    expect(screen.getByText('1 project without a folder')).toBeInTheDocument();
    expect(screen.getByText('The folder of demo was deleted')).toBeInTheDocument();
    expect(screen.getByTestId('diagnosis-open-session')).toHaveTextContent('flow diagnose · 1 project');
    expect(screen.queryByTestId('diagnosis-details')).toBeNull();
    expect(screen.queryByTestId('diagnosis-fix')).toBeNull(); // no local fix: no Fix

    fireEvent.click(screen.getByTestId('diagnosis-details-toggle'));
    expect(screen.getByTestId('diagnosis-details')).toHaveTextContent('Remove the entry.');
  });

  it('offers Fix only when the diagnosis can apply its fix here, and Ask for help opens the support request', async () => {
    sdk.held.mockResolvedValue({ items: [], private: true });
    sdk.diagnosis.mockResolvedValue(answer({}, { local_fix: true }));
    sdk.fix.mockResolvedValue(undefined);
    sdk.report.mockResolvedValue({});
    render(<DiagnosisCard conversationId="c1" isMine />);

    fireEvent.click(await screen.findByTestId('diagnosis-fix'));
    await waitFor(() => expect(sdk.fix).toHaveBeenCalledWith('c1'));
    fireEvent.click(screen.getByTestId('diagnosis-ask'));
    await waitFor(() => expect(sdk.report).toHaveBeenCalledWith('c1'));
  });

  it('Done archives the conversation and settles the entry it was started from', async () => {
    sdk.held.mockResolvedValue({ items: [], private: true });
    sdk.diagnosis.mockResolvedValue(answer());
    sdk.archive.mockResolvedValue({});
    render(<DiagnosisCard conversationId="c1" isMine />);

    fireEvent.click(await screen.findByTestId('diagnosis-done'));

    await waitFor(() => expect(sdk.archive).toHaveBeenCalledWith({ conversation_id: 'c1' }));
    expect(useDiagnosisLinks.getState().done).toContain('c1');
  });

  it.each([
    ['fixed', 'Fixed'],
    ['help_requested', 'Help requested'],
    ['done', 'Done'],
    ['diagnosing', 'Diagnosing'],
  ])('in state %s the chip says %s and no Fix is offered', async (state, chip) => {
    sdk.held.mockResolvedValue({ items: [], private: true });
    sdk.diagnosis.mockResolvedValue(answer({ state, reported: state === 'help_requested' }, { local_fix: true }));
    render(<DiagnosisCard conversationId="c1" isMine />);

    expect(await screen.findByTestId('diagnosis-status')).toHaveTextContent(chip);
    expect(screen.queryByTestId('diagnosis-fix')).toBeNull();
  });
});
