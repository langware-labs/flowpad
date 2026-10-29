/**
 * On the hub, Share on a project said "Project not published — publish it to the cloud
 * first": a hub project row carries no `remote` flag, but on the hub every project IS
 * its hub row. Share there opens the share dialog, never the publish popup.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ hub: false }));

vi.mock('@src/navigation/hub-runtime', () => ({ isHubOnly: () => h.hub }));
vi.mock('@src/hooks/entity-hooks', () => ({ useEntity: () => ({ data: { id: 'p1', name: 'Course' } }) }));
vi.mock('@src/hooks/use-entity-share', () => ({ useEntityShare: () => ({ canShare: true, isAgenticProcess: false }) }));
vi.mock('@src/hooks/share-sources', () => ({
  agenticProcessShareSource: vi.fn(),
  genericEntityShareSource: vi.fn(),
  projectShareSource: vi.fn(),
}));
vi.mock('@src/components/favorites/FavoriteStar', () => ({ FavoriteStar: () => null }));
vi.mock('@src/components/entity-actions/CloudAssetPublishButton', () => ({ CloudAssetPublishButton: () => null }));
vi.mock('@src/components/share-to-conversation/ShareToConversationDialog', () => ({
  ShareToConversationDialog: () => <div data-testid="share-dialog" />,
}));
vi.mock('@src/components/project-home/PublishProjectDialog', () => ({
  PublishProjectDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="publish-dialog" /> : null),
}));

import { Project, TypeId } from '@sdk';
import { EntityActionsToolbar } from '@src/components/entity-actions/EntityActionsToolbar';
import { TooltipProvider } from '@src/components/ui/tooltip';

const typeId = new TypeId(Project.type, '11111111-1111-4111-8111-111111111111');

afterEach(() => cleanup());

describe('Share on an unpublished-looking project', () => {
  it('opens the share dialog on the hub', () => {
    h.hub = true;
    render(
      <TooltipProvider>
        <EntityActionsToolbar typeId={typeId} favoriteTitle="Course" />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByTestId('entity-actions-share'));

    expect(screen.queryByTestId('publish-dialog')).toBeNull();
    expect(screen.getByTestId('share-dialog')).toBeTruthy();
  });

  it('asks to publish first on a local backend', () => {
    h.hub = false;
    render(
      <TooltipProvider>
        <EntityActionsToolbar typeId={typeId} favoriteTitle="Course" />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByTestId('entity-actions-share'));

    expect(screen.getByTestId('publish-dialog')).toBeTruthy();
  });
});
