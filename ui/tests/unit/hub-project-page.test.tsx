import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  currentDock: { pointer: '' } as { pointer?: string },
  openDock: vi.fn(),
  query: vi.fn(),
  typeInfos: [] as Array<Record<string, unknown>>,
}));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ currentDock: h.currentDock, navigation: { openDock: h.openDock } }),
}));
vi.mock('@src/components/project-home/ProjectHome', () => ({
  ProjectHome: ({ cloudContent }: { cloudContent?: React.ReactNode }) => (
    <div data-testid="project-shell">{cloudContent}</div>
  ),
}));
vi.mock('@src/components/assets/editor/AssetEditorRouter', () => ({
  AssetEditorRouter: ({ pointer, hubReflect }: { pointer: string; hubReflect?: boolean }) => (
    <div data-testid="asset-editor" data-pointer={pointer} data-hub-reflect={String(hubReflect)} />
  ),
}));
vi.mock('@src/components/graph-view/icons/iconRegistry', () => ({
  iconForType: () => (props: Record<string, unknown>) => <span {...props} />,
}));
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dataManager: {
      getAllTypeInfos: () => h.typeInfos,
      query: h.query,
    },
    dataContext: { bootstrapInfo: { schemas: [] } },
  };
});

import { TypeId } from '@sdk';
import { hubProjectAssetDock } from '@src/lib/hub-page-url';

import { HubProjectPage, hubEditableAssetTypes } from '@src/pages/hub-project/HubProjectPage';

const PROJECT_ID = '12345678-0000-4000-8000-000000000000';
const ASSET_ID = 'abcdef12-0000-4000-8000-000000000000';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <HubProjectPage />
    </QueryClientProvider>,
  );
}

describe('HubProjectPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.currentDock = { pointer: PROJECT_ID };
    h.typeInfos = [{ type_name: 'markdown', cloud_file_transport: 'git' }];
    h.query.mockResolvedValue([
      {
        id: ASSET_ID,
        type: 'markdown',
        displayName: 'Read me',
        typeId: new TypeId('markdown', ASSET_ID),
      },
    ]);
  });
  afterEach(() => cleanup());

  it('queries editable assets under the Project scope and navigates URL-first', async () => {
    renderPage();
    await userEvent.click(await screen.findByText('Read me'));

    const request = h.query.mock.calls[0][0];
    expect(request.type).toBe('markdown');
    expect(request.scope.map((scope: TypeId) => scope.toString())).toEqual([`project-${PROJECT_ID}`]);
    expect(h.openDock).toHaveBeenCalledOnce();
    expect(h.openDock.mock.calls[0][0].toUrl()).toBe(
      `/dock/hub/project/${PROJECT_ID}/editor/markdown/typeid/markdown-${ASSET_ID}`,
    );
  });

  it('routes a Project asset sub-pointer through the existing Hub-reflected editor', () => {
    const dock = hubProjectAssetDock(PROJECT_ID, new TypeId('markdown', ASSET_ID));
    h.currentDock = { pointer: dock.pointer };
    renderPage();

    const editor = screen.getByTestId('asset-editor');
    expect(editor.getAttribute('data-hub-reflect')).toBe('true');
    expect(editor.getAttribute('data-pointer')).toBe(`editor/markdown/typeid/markdown-${ASSET_ID}`);
  });

  it('uses registry transport metadata with legacy schema deltas as compatibility input', () => {
    expect(
      hubEditableAssetTypes(
        [
          { type_name: 'skill', cloud_file_transport: 'git' },
          { type_name: 'task', cloud_file_transport: 'embedded' },
        ],
        [
          { properties: { type: { const: 'markdown' }, asset_ref: { type: 'string' } } },
          { properties: { type: { const: 'agent' } } },
          { properties: { type: { const: 'skill' } } },
          { properties: { type: { const: 'conversation' } } },
        ],
      ),
    ).toEqual(['agent', 'markdown', 'skill']);
  });
});
