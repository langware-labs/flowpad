/**
 * A document tab's hover card says what the document is and where it lives,
 * and its Vibe | Chat | Terminal bar starts a review of THAT document through
 * navigation — nothing else happens in the click.
 */
import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Tab } from '@sdk';
import { ViewMode } from '@src/contexts/view-mode-context';
import { DockPointer } from '@src/navigation/DockPointer';
import { DocTabCard } from '@src/tabs/doc-tab-card';
import { contentAssetTargetForDock, isReviewableDocDock, reviewPromptFor } from '@src/navigation/content-asset-dock';
import { ViewType } from '@src/types/ViewType';

const reviewDocument = vi.hoisted(() => vi.fn());
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { reviewDocument } }),
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
  it('names the document and starts a review on the picked surface', () => {
    const tab = docTab('11111111-1111-4111-8111-111111111111');
    const dock = new DockPointer(tab.dockPointer!);
    render(<DocTabCard tab={tab} dock={dock} typeLabel="Editor" />);

    expect(screen.getByTestId('tab-tooltip-name')).toHaveTextContent('arch_blueprint.html');
    expect(screen.getByTestId('doc-tab-card-kind')).toHaveTextContent('html');
    expect(screen.getByText(PATH)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId(`doc-tab-card-review-${ViewMode.Vibe}`));
    expect(reviewDocument).toHaveBeenCalledWith(dock, ViewMode.Vibe, tab.project_id, PATH);
    expect(reviewPromptFor(contentAssetTargetForDock(dock)!)).toBe(`Review the html on ${PATH}:`);
  });

  it('offers no Vibe review for a tab with no project', () => {
    const tab = docTab(null);
    render(<DocTabCard tab={tab} dock={new DockPointer(tab.dockPointer!)} typeLabel="Editor" />);
    expect(screen.queryByTestId(`doc-tab-card-review-${ViewMode.Vibe}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`doc-tab-card-review-${ViewMode.Advanced}`)).toBeInTheDocument();
  });

  it('is not offered for a tab that is not one document', () => {
    const dock = new DockPointer({ viewType: ViewType.SETTINGS, pointer: '' });
    expect(isReviewableDocDock(dock)).toBe(false);
  });
});
