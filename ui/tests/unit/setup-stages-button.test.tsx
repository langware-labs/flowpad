import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DataSource, type DataDriver } from '@sdk';
import { SetupStagesButton } from '@src/components/setup-wizard/SetupStagesButton';

vi.mock('@src/components/setup-wizard/SetupWizardDialog', () => ({ SetupWizardDialog: () => null }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('reports pending wizard setup without calling a running source disconnected', async () => {
  const source = new DataSource();
  source.status = 'active';
  vi.spyOn(source, 'setupStages').mockResolvedValue([
    { stage: 'test', label: 'Test', wizard: 'test-wizard', state: 'pending', detail: '' },
  ]);
  render(<SetupStagesButton source={source} spec={{ setup_wizards: [{ stage: 'test', wizard: 'test-wizard' }] } as DataDriver} />);
  expect(await screen.findByRole('button', { name: 'Finish setup' })).toHaveAttribute('title', 'Continue setup: Test');
  expect(screen.queryByRole('button', { name: 'Not connected' })).toBeNull();
});
