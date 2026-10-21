import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProjectPublishedButton } from '@src/components/project-home/ProjectPublishedButton';

const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const openDiscover = vi.hoisted(() => vi.fn());
const published = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDiscover }, currentDock: null, isDockUrl: false, windowMode: null }),
}));

vi.mock('@sdk', async (orig) => {
  const real = await orig<typeof import('@sdk')>();
  return {
    ...real,
    dataManager: {
      ...real.dataManager,
      getByTypeId: () => Promise.resolve({ getPublished: () => Promise.resolve(published) }),
    },
  };
});

afterEach(cleanup);

describe('ProjectPublishedButton', () => {
  it('shows how many assets are published, and only navigates — URL-first', async () => {
    published.rows = [{}, {}];
    render(<ProjectPublishedButton projectId={PROJECT_ID} />);
    const button = await screen.findByTestId('project-published');
    expect(button).toHaveTextContent('Published2');
    await userEvent.click(button);
    expect(openDiscover).toHaveBeenCalledTimes(1);
    expect(openDiscover).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('is not shown while the project has published nothing', async () => {
    published.rows = [];
    render(<ProjectPublishedButton projectId={PROJECT_ID} />);
    await waitFor(() => expect(screen.queryByTestId('project-published')).not.toBeInTheDocument());
  });
});
