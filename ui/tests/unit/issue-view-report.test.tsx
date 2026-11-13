/**
 * An issue's own page is its report: what happened (the hub's events), the technical cause, whose machine
 * and for how long. Only the entity read is stubbed.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Issue } from '@sdk';

const ISSUE_ID = '550e8400-e29b-41d4-a716-446655440000';
const T0 = 1_800_000_000;

const issue = new Issue({
  id: ISSUE_ID,
  kind: 'deployment_unreachable',
  severity: 'warning',
  status: 'resolved',
  title: "Machine can't be reached",
  detail: "Flowpad couldn't ask the provider about the machine.",
  cause: 'connection error: connection reset',
  machine: 'visitor 8f99',
  subject_typeid: 'deployment-abdd87d7-b8ec-45e8-817f-f2e9b1fbefc4',
  opened_at: T0,
  resolved_at: T0 + 50,
  events: [
    { at: T0, what: 'opened', detail: 'connection error: connection reset' },
    { at: T0 + 50, what: 'resolved', detail: '' },
  ],
});

vi.mock('@sdk/react/hooks', async (original) => ({
  ...(await original<typeof import('@sdk/react/hooks')>()),
  useEntity: () => ({ data: issue, isLoading: false }),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDockOnThisPage: vi.fn() } }),
}));

const { IssueView } = await import('@src/components/items/IssueView');

describe('IssueView', () => {
  it('reports what happened, the real cause, the machine and how long it lasted', () => {
    render(<IssueView id={ISSUE_ID} />);
    const events = screen.getByTestId('issue-report-events').textContent ?? '';
    expect(events).toContain('Opened');
    expect(events).toContain('Resolved by itself');
    expect(screen.getByTestId('issue-report-cause').textContent).toContain('connection reset');
    const affected = screen.getByTestId('issue-report-affected').textContent ?? '';
    expect(affected).toContain('visitor 8f99');
    expect(affected).toContain('50s');
    expect(screen.getByTestId('issue-report-evidence').textContent).toContain('deployment-abdd87d7');
  });
});
