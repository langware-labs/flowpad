/**
 * What an automation posted reads as a card: the Status chip, the Summary in a line, the rest folded under
 * Details, and the session it called back one click away.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const openShellProcess = vi.fn();
vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => ({ navigation: { openShellProcess } }) }));
vi.mock('@sdk/react/hooks', () => ({ useEntity: () => ({ data: { name: 'Messaging Ishay' } }) }));

import { AutomationResultCard } from '@src/components/conversation/AutomationResultCard';

afterEach(cleanup);

describe('an automation result card', () => {
  it('shows the status and the summary, folds the details, and opens the session', () => {
    render(
      <AutomationResultCard
        result={{
          status: 'expired',
          summary: 'Ishay did not reply to “hi” within 3 days, so the follow-up was not sent.',
          details: [{ label: 'Waited until', value: '19 Nov 2026, 10:36 UTC' }],
          session: 'agentic_process-7fdc9435-e260-4d21-8bdd-9e4dccff8f33',
        }}
      />,
    );
    expect(screen.getByTestId('automation-result-card').getAttribute('data-status')).toBe('expired');
    expect(screen.getByTestId('automation-result-status').textContent).toBe('Expired');
    expect(screen.getByText(/did not reply to “hi” within 3 days/)).toBeTruthy();

    expect(screen.queryByTestId('automation-result-details')).toBeNull();
    fireEvent.click(screen.getByTestId('automation-result-details-toggle'));
    expect(screen.getByTestId('automation-result-details').textContent).toContain('19 Nov 2026, 10:36 UTC');

    fireEvent.click(screen.getByTestId('automation-result-open-session'));
    expect(openShellProcess).toHaveBeenCalledWith('7fdc9435-e260-4d21-8bdd-9e4dccff8f33');
  });

  it('a result with nothing more to say has no Details and no session button', () => {
    render(<AutomationResultCard result={{ status: 'failed', summary: 'Daily usage summary could not run.', details: [] }} />);
    expect(screen.getByTestId('automation-result-status').textContent).toBe('Failed');
    expect(screen.queryByTestId('automation-result-details-toggle')).toBeNull();
    expect(screen.queryByTestId('automation-result-open-session')).toBeNull();
  });
});
