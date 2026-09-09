import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProjectPublishedButton } from '@src/components/project-home/ProjectPublishedButton';

const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const openDiscover = vi.hoisted(() => vi.fn());

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDiscover }, currentDock: null, isDockUrl: false, windowMode: null }),
}));

afterEach(cleanup);

describe('ProjectPublishedButton', () => {
  it('only navigates — through navigation.openDiscover, URL-first', async () => {
    render(<ProjectPublishedButton projectId={PROJECT_ID} />);
    await userEvent.click(screen.getByRole('button', { name: 'Published' }));
    expect(openDiscover).toHaveBeenCalledTimes(1);
    expect(openDiscover).toHaveBeenCalledWith(PROJECT_ID);
    expect(screen.getByTestId('project-published')).toBeInTheDocument();
  });
});
