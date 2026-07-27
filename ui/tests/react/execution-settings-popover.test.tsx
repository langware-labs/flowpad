import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PrefKey, instancePreferences } from '@sdk';

vi.mock('@src/hooks/entity-hooks', () => ({
  useEntitiesQuery: () => ({
    data: [{ id: 'project-1', displayName: 'Project One' }],
    isLoading: false,
  }),
}));

import { ExecutionSettingsPopover } from '@src/components/entity-execution-panel/ExecutionSettingsPopover';

describe('ExecutionSettingsPopover', () => {
  beforeEach(() => {
    instancePreferences.set(PrefKey.CHAT_SHOW_TOOLS, false);
  });

  afterEach(() => {
    cleanup();
    instancePreferences.set(PrefKey.CHAT_SHOW_TOOLS, false);
  });

  it('renders process settings and persists the shared tool-call preference', async () => {
    const user = userEvent.setup();
    const onProjectChange = vi.fn();

    render(
      <ExecutionSettingsPopover
        activeProcess={null}
        projectId="project-1"
        onProjectChange={onProjectChange}
        modelControl={<div data-testid="model-control">Balanced</div>}
        workerControl={<div data-testid="worker-control">Claude</div>}
        trigger={<button type="button">Settings</button>}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Settings' }));

    expect(screen.getByTestId('execution-settings-popover')).toBeInTheDocument();
    expect(screen.getByTestId('execution-settings-project')).toHaveTextContent('Project One');
    expect(screen.getByTestId('execution-settings-model-section')).toContainElement(screen.getByTestId('model-control'));
    expect(screen.getByTestId('execution-settings-worker-section')).toContainElement(screen.getByTestId('worker-control'));

    await user.click(screen.getByRole('checkbox', { name: 'Show tool calls' }));

    expect(instancePreferences.get(PrefKey.CHAT_SHOW_TOOLS)).toBe(true);
  });
});
