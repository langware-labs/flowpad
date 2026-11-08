/**
 * A diagnosis message offers the ONE action its cause calls for, and nothing when the cause is the person's own.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ diagnosis: vi.fn(), report: vi.fn() }));
vi.mock('@sdk', async (orig) => ({
  ...(await orig<typeof import('@sdk')>()),
  helpRequestDiagnosis: sdk.diagnosis,
  helpRequestReport: sdk.report,
}));
import { DiagnosisMessageActions } from '@src/components/conversation/DiagnosisMessageActions';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const verdict = (cause: string) => ({ status: 'needs_action', cause, cause_asset: '', title: 't', summary: 's' });

describe('DiagnosisMessageActions', () => {
  it.each([
    ['Flowpad support', '', 'Report it'],
    ["acme-planner's help desk", '', "Report it to acme-planner's help desk"],
    ['Flowpad support', 'plan-kit', 'Report it for me'],
  ])('reports to %s (pass on "%s") as "%s"', async (desk, passOn, label) => {
    sdk.diagnosis.mockResolvedValue({ diagnosing: false, diagnosis: verdict('flowpad'), reportable: true, reported: false, desk, pass_on: passOn });
    sdk.report.mockResolvedValue({});
    render(<DiagnosisMessageActions conversationId="c1" isMine />);

    fireEvent.click(await screen.findByText(label));

    await waitFor(() => expect(sdk.report).toHaveBeenCalledWith('c1'));
  });

  it('offers nothing to report when the cause is the person\'s own, and folds the details', async () => {
    sdk.diagnosis.mockResolvedValue({ diagnosing: false, diagnosis: { ...verdict('project'), status: 'fixed', fix: 'Repaired plans/q3.json' }, reportable: false, reported: false, desk: '', pass_on: '' });
    render(<DiagnosisMessageActions conversationId="c1" isMine />);

    fireEvent.click(await screen.findByTestId('diagnosis-details-toggle'));

    expect(screen.getByTestId('diagnosis-details')).toHaveTextContent('Repaired plans/q3.json');
    expect(screen.queryByTestId('diagnosis-report')).toBeNull();
  });
});
