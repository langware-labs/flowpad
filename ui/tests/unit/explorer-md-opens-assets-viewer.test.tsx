import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { TypeId } from '@sdk';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { ContentPanel } from '@src/pages/flow-page/content-panel/content-panel';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression: double-clicking a `.md` file in the file browser (Explorer) must
 * open it as a DOCUMENT in the assets viewer (`/dock/assets/editor/markdown/…`),
 * not as raw text in the code editor (`/dock/editor/compute_node-…/…`).
 *
 * The code editor surface has no share button, no document rendering, no
 * chat/backlinks — a .md opened there is a dead end. The routing decision is
 * ContentPanel's `handleExplorerFileSelect`, which today calls
 * `DockPointer.forFile(path)` unconditionally (→ ViewType.EDITOR) with no
 * extension dispatch.
 *
 * The test mounts the REAL chain — ContentPanel (the decision point) →
 * ExplorerView → SimpleFileManager row — under a real router, double-clicks the
 * .md row, and asserts the URL the app lands on. Only chrome (tab strip,
 * navigator, user dropdown) and the data layer (fs listing, compute-node
 * resolution) are stubbed; the routing path under test is fully real.
 */

// ── chrome stubs (not the unit under test) ──────────────────────────────────
vi.mock('@src/pages/flow-page/content-panel/unified-tab-strip', () => ({
  UnifiedTabStrip: () => null,
}));
vi.mock('@src/pages/flow-page/content-panel/user-dropdown/user-dropdown', () => ({
  UserDropdown: () => null,
}));
vi.mock('@src/navigation/NavigatorSlot', () => ({
  NavigatorSlot: () => null,
}));

// Heavy sibling surfaces content-panel imports at module level; none of them
// render in this test (the dock is EXPLORER, then the failing target). Stubbed
// so the import graph stays jsdom-safe (xterm/monaco).
vi.mock('@src/components/terminal', () => ({ TabbedTerminal: () => null }));
vi.mock('@src/components/code-editor/CodeEditor', () => ({ default: () => null }));
vi.mock('@src/components/code-editor/DiffViewer', () => ({ default: () => null }));

// ── app-context stubs ───────────────────────────────────────────────────────
vi.mock('@src/components/agent-layout/agent-layout', () => ({
  useAgentContext: () => ({ flow: null, agent: null }),
}));
vi.mock('@sdk/react/hooks', async (orig) => ({
  ...(await orig<typeof import('@sdk/react/hooks')>()),
  useAuth: () => ({ user: { id: 'user-1' } }),
  useContext: () => ({ project: null }),
}));
vi.mock('@src/hooks/flow-hooks', async (orig) => ({
  ...(await orig<typeof import('@src/hooks/flow-hooks')>()),
  useActiveViewer: () => {},
}));
vi.mock('@src/tabs/use-tab-manager', async (orig) => ({
  ...(await orig<typeof import('@src/tabs/use-tab-manager')>()),
  useTerminalTabs: () => [],
  useTabLifecycle: () => undefined,
}));
vi.mock('@src/components/view-mode', async (orig) => ({
  ...(await orig<typeof import('@src/components/view-mode')>()),
  useIsVibe: () => false,
}));

// ── data layer stubs (the browser lists one real .md) ───────────────────────
// vi.hoisted so the mock factories below can share the SAME values the
// assertions use — no drift between the stubbed listing and the expected URL.
const { COMPUTE_NODE_ID, MD_NAME } = vi.hoisted(() => ({
  COMPUTE_NODE_ID: 'd6978791-9503-5f73-a4f2-d85e581a4fff',
  MD_NAME: 'SAPAK-DEMO-SPEC.md',
}));
const COMPUTE_NODE = new TypeId('compute_node', COMPUTE_NODE_ID);

vi.mock('@src/components/explorer-view/useExplorerComputeNode', async () => {
  const { TypeId: TypeIdCls } = await import('@sdk');
  return {
    useExplorerComputeNode: () => ({
      typeId: new TypeIdCls('compute_node', COMPUTE_NODE_ID),
      anchorForScope: () => '',
      projectRootPath: null,
    }),
  };
});

vi.mock('@src/hooks/useFS', () => ({
  useFS: () => ({
    browse: () => ({
      items: [
        {
          name: MD_NAME,
          relativePath: `/${MD_NAME}`,
          is_dir: false,
          size: 1234,
          last_modified: 1751800000,
        },
      ],
    }),
    listDirectory: async () => [],
    invalidate: () => {},
  }),
}));

// ── URL probe: what the app actually navigates to ───────────────────────────
let lastPath = '';
function LocationProbe() {
  lastPath = useLocation().pathname;
  return null;
}

afterEach(() => cleanup());

describe('Explorer file browser — .md routing', () => {
  it('double-clicking a .md opens the assets document viewer, not the code editor', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <MemoryRouter initialEntries={['/dock/explorer']}>
          <LocationProbe />
          <Routes>
            <Route path="dock/:viewType" element={<ContentPanel />} />
            <Route path="dock/:viewType/*" element={<ContentPanel />} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
      </QueryClientProvider>,
    );

    // The real SimpleFileManager row for the markdown file.
    const cell = await screen.findByText(MD_NAME);
    const row = cell.closest('tr');
    expect(row).not.toBeNull();

    fireEvent.doubleClick(row!);

    // Navigation must happen (the double-click is wired) …
    await waitFor(() => expect(lastPath).not.toBe('/dock/explorer'));

    // … and must land on the assets DOCUMENT viewer for the markdown asset,
    // not the raw code editor. Today this fails with
    // `/dock/editor/compute_node-…/SAPAK-DEMO-SPEC.md` (ViewType.EDITOR).
    expect(lastPath).toMatch(/^\/dock\/assets\/editor\/markdown\//);
    expect(lastPath).toContain(COMPUTE_NODE.id);
  });
});
