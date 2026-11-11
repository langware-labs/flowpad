/**
 * A document tab's hover card says what the document is and where it lives.
 * Chatting about it is the viewer's own Chat toggle, not the card.
 */
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Tab } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { DocTabCard } from '@src/tabs/doc-tab-card';
import { offersDocChat } from '@src/navigation/content-asset-dock';
import { ViewType } from '@src/types/ViewType';

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: {} }),
}));
vi.mock('@src/contexts/view-mode-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@src/contexts/view-mode-context')>()),
  useIsAdvanced: () => false,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const PATH = '/work/acme/arch_blueprint.html';

function docTab(projectId: string | null): Tab {
  const dock = new DockPointer({ viewType: ViewType.EDITOR, pointer: PATH });
  return new Tab({ name: 'arch_blueprint.html', pointer: dock.toJSON(), project_id: projectId } as never);
}

describe('DocTabCard', () => {
  it('names the document and where it lives', () => {
    const tab = docTab('11111111-1111-4111-8111-111111111111');
    const dock = new DockPointer(tab.dockPointer!);
    render(<DocTabCard tab={tab} dock={dock} typeLabel="Editor" />);

    expect(screen.getByTestId('tab-tooltip-name')).toHaveTextContent('arch_blueprint.html');
    expect(screen.getByTestId('doc-tab-card-kind')).toHaveTextContent('html');
    expect(screen.getByText(PATH)).toBeInTheDocument();
  });

  it('is not offered for a tab that is not one document', () => {
    const dock = new DockPointer({ viewType: ViewType.SETTINGS, pointer: '' });
    expect(offersDocChat(dock)).toBe(false);
  });
});
