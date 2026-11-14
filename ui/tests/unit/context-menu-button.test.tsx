/**
 * The Context button lists an entity's context — who it holds and who holds it — as one
 * list, read when the menu opens. A row only navigates; on the hub the button is not drawn.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  hub: false,
  openDock: vi.fn(),
  rows: [
    { direction: 'in', typeid: 'conversation-22222222-2222-4222-8222-222222222222', type: 'conversation', name: 'Spring launch', kind: 'shared', role: 'session', time: '2026-11-13T10:00:00Z' },
    { direction: 'out', typeid: 'spec-33333333-3333-4333-8333-333333333333', type: 'spec', name: '', kind: 'private', role: '', time: '' },
  ],
}));

vi.mock('@src/navigation/hub-runtime', () => ({ isHubOnly: () => h.hub }));
vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => ({ navigation: { openDock: h.openDock } }) }));
vi.mock('@src/components/view-mode', () => ({ useIsDev: () => false }));
vi.mock('@src/hooks/entity-hooks', () => ({ useEntity: () => ({ data: null }) }));
vi.mock('@src/hooks/use-entity-share', () => ({ useEntityShare: () => ({ canShare: true, isAgenticProcess: false }) }));
vi.mock('@src/hooks/share-sources', () => ({
  agenticProcessShareSource: vi.fn(),
  genericEntityShareSource: vi.fn(),
  projectShareSource: vi.fn(),
}));
vi.mock('@src/components/favorites/FavoriteStar', () => ({ FavoriteStar: () => null }));
vi.mock('@src/components/entity-actions/CloudAssetPublishButton', () => ({ CloudAssetPublishButton: () => null }));
vi.mock('@src/components/share-to-conversation/ShareToConversationDialog', () => ({ ShareToConversationDialog: () => null }));
vi.mock('@src/components/project-home/PublishProjectDialog', () => ({ PublishProjectDialog: () => null }));

import { TypeId, dataManager } from '@sdk';
import { EntityActionsToolbar } from '@src/components/entity-actions/EntityActionsToolbar';
import { TooltipProvider } from '@src/components/ui/tooltip';

const typeId = new TypeId('task', '11111111-1111-4111-8111-111111111111');
const toolbar = (
  <TooltipProvider>
    <EntityActionsToolbar typeId={typeId} favoriteTitle="A task" showContext />
  </TooltipProvider>
);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  h.openDock.mockReset();
});

describe('Context button', () => {
  it('lists both directions and a row opens its entity', async () => {
    h.hub = false;
    vi.spyOn(dataManager, 'getByTypeId').mockResolvedValue({ getContextRelations: () => Promise.resolve(h.rows) } as never);
    render(toolbar);

    fireEvent.click(screen.getByTestId('entity-actions-context'));
    const rows = await waitFor(() => {
      const found = screen.getAllByTestId('context-menu-row');
      expect(found).toHaveLength(2);
      return found;
    });
    expect(rows.map((row) => row.dataset.direction)).toEqual(['in', 'out']);
    expect(rows[0].textContent).toContain('Spring launch');
    // Nothing names the second one: it goes by the start of its id, and has no time.
    expect(rows[1].textContent).toContain('33333333');
    expect(rows[1].textContent).toContain('—');

    fireEvent.click(rows[0]);
    await waitFor(() => expect(h.openDock).toHaveBeenCalledTimes(1));
    expect(String(h.openDock.mock.calls[0][0].pointer)).toContain('22222222-2222-4222-8222-222222222222');
  });

  it('is not drawn on the hub', () => {
    h.hub = true;
    render(toolbar);
    expect(screen.queryByTestId('entity-actions-context')).toBeNull();
  });
});
