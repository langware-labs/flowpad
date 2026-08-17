import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FlowData, FlowElementTypes, PrefKey, instancePreferences } from '@sdk';
import { TurnGroupsList } from '@src/components/entity-execution-panel/TurnGroupsList';
import { groupTurnEvents } from '@src/components/floating-chat/groupTurnEvents';

function unavailableEntry(): FlowData {
  return new FlowData(
    FlowElementTypes.WORKER_UNAVAILABLE,
    JSON.stringify({
      kind: 'worker_unavailable',
      worker_type: 'claude_code',
      reason: 'quota_exhausted',
      message: 'Weekly limit reached. Try another worker.',
    }),
    {
      i: '1',
      t: '2026-07-27T12:00:00.000Z',
      'data-type': 'object',
    },
  );
}

describe('WorkerUnavailableNotice', () => {
  afterEach(() => {
    instancePreferences.set(PrefKey.CHAT_SHOW_TOOLS, false);
  });

  it('stays visible with tools hidden and routes worker selection to the host', async () => {
    const user = userEvent.setup();
    const onWorkerChange = vi.fn();
    instancePreferences.set(PrefKey.CHAT_SHOW_TOOLS, false);

    // The worker select routes a capability-warned pick to Capabilities, so it
    // needs a router. No HarnessCapabilitiesProvider here means no warnings —
    // every worker stays selectable, which is what this test asserts.
    render(
      <MemoryRouter initialEntries={['/dock/shell']}>
        <TurnGroupsList
          groups={groupTurnEvents([unavailableEntry()])}
          worker="claude_code"
          onWorkerChange={onWorkerChange}
        />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('worker-unavailable-notice')).toHaveTextContent(
      'Weekly limit reached. Try another worker.',
    );
    expect(screen.getByTestId('worker-unavailable-worker-select')).toHaveTextContent('Claude');

    await user.click(screen.getByTestId('worker-unavailable-worker-select'));
    await user.click(await screen.findByTestId('vibe-worker-option-codex'));

    expect(onWorkerChange).toHaveBeenCalledWith('codex');
  });
});
