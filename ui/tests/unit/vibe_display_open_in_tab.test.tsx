/**
 * The reported failure, end to end:
 *
 *   1. open the vibe workspace with a doc on the display
 *   2. click ⧉ "Open in a new tab"       → a chip named after the doc
 *   3. click back on the Display header  → (A) the chip renames itself "Assets"
 *   4. click that chip                   → (B) it opens the Assets root, not the doc
 *
 * Stage 1 clicks the REAL button inside a REAL `VibeWorkspace`, so it covers the
 * wiring in `openPtrInTab` — the line the bug lived on. Stage 2 feeds the dock
 * that click produced into the REAL `WorkspaceChildStrip`, with the Display
 * active: exactly the deselected state where the label and the reopen target
 * went wrong. The display-history popover promotes a past display the same way,
 * so it is covered here too rather than left to rot into the same bug.
 *
 * Mocks are ambient only — agent context, dock navigation (the observation
 * point), the chat pane. Nothing on the path under test is mocked: the pointer
 * construction, the tab mint, the chip title and the reopen navigation are all
 * real product code.
 */
import { type PropsWithChildren } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgenticProcess, dataManager, Tab } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';

const PROJECT_ID = 'f20cecb9-72e7-4cd4-92f2-61b5c48b45cf';
const DOC_PATH = '/Users/shlom/Flowpad workspace/content/machine-learning-2-0.md';
const DOC_NAME = 'machine-learning-2-0.md';
const PROCESS_ID = '853880a0-dd7b-4872-9db2-3bc2b97390dd';

const processDock = new DockPointer(ViewType.SHELL, `agentic_process-${PROCESS_ID}`);
const openDock = vi.fn();
let currentDock = processDock;
let showListener: ((target: Record<string, unknown>) => void) | null = null;

const process = new AgenticProcess({ id: PROCESS_ID });
vi.spyOn(process, 'on').mockImplementation((event, listener) => {
  if (event === 'show') showListener = listener as (t: Record<string, unknown>) => void;
  return () => {};
});

vi.mock('@src/contexts/agent-context', () => ({
  useAgentContext: () => ({ project: { id: PROJECT_ID } }),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ currentDock, navigation: { openDock } }),
  useCurrentDock: () => currentDock,
}));
vi.mock('@src/pages/flow-page/vibe-chat-pane', () => ({
  VibeChatPane: () => <div data-testid="vibe-chat-pane" />,
}));
vi.mock('@src/pages/flow-page/use-vibe-workspace-session', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useVibeWorkspaceSessionHost: () => process,
}));

import { VibeWorkspace } from '@src/pages/flow-page/vibe-workspace';
import { WorkspaceChildStrip } from '@src/pages/flow-page/workspace-child-strip';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { applyAllTabs } from '@src/tabs/all-tabs-store';

/** Providers the real components need; none of them is on the path under test. */
const queryClient = new QueryClient();
const Wrap = ({ children }: PropsWithChildren) => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>{children}</TooltipProvider>
  </QueryClientProvider>
);

const session = { processId: PROCESS_ID, processDock, processTab: null, onProcessUrl: true };

/** The workspace anchor tab the children hang off. */
const processTab = new Tab({
  id: '090ba727-a426-5827-99c6-534b8579f9f3',
  pointer: processDock.toJSON(),
  target_type: 'agentic_process',
  target_id: PROCESS_ID,
} as never);

/**
 * Mount the workspace with a document on the display, and the same document in
 * the process's display history (`context_data.display_stack` — the field the
 * backend writes on every `flow show`, which `AgenticProcess.displayStack` reads).
 */
function mountWithShownDoc(): void {
  process.context_data = { display_stack: [{ kind: 'vfs', path: DOC_PATH, shown_at: 1 }] } as never;
  render(
    <Wrap>
      <VibeWorkspace session={session as never} />
    </Wrap>,
  );
  expect(showListener).not.toBeNull();
  act(() => showListener?.({ kind: 'vfs', path: DOC_PATH }));
}

/** The dock the last click navigated to. */
function lastOpened(): DockPointer {
  return openDock.mock.calls.at(-1)![0] as DockPointer;
}

/**
 * Steps 3-4: the child tab the backend mints from `opened`, rendered in the real
 * strip with the Display active. Returns the chip's label and where clicking it
 * navigates.
 *
 * `Tab.getFromDockPointer` needs a live backend, so the row is built from the
 * SAME two product calls it sends (entities/tab.ts:354-356) — `dock.toJSON()`
 * for the pointer and `dataManager.getTabName(dock)` for the name. Both are the
 * real implementations; neither is re-derived here.
 */
function chipFor(opened: DockPointer): { label: string; reopened: DockPointer } {
  applyAllTabs([
    new Tab({
      id: 'f5ce6f9c-3a51-5205-bb9b-40bf97e27e65',
      pointer: opened.toJSON(),
      name: dataManager.getTabName(opened),
      target_type: 'markdown',
      parent_tab_id: processTab.id,
    } as never),
  ]);
  currentDock = processDock; // back on the Display — the chip is DESELECTED
  openDock.mockReset();
  render(
    <Wrap>
      <WorkspaceChildStrip processTab={processTab} processDock={processDock} projectId={PROJECT_ID} />
    </Wrap>,
  );

  const chip = document.querySelector('[data-testid^="tab-content-"]');
  fireEvent.click(chip!);
  return { label: chip?.textContent?.trim() ?? '', reopened: lastOpened() };
}

afterEach(() => {
  cleanup();
  applyAllTabs([]);
  openDock.mockReset();
  showListener = null;
  currentDock = processDock;
  process.context_data = {};
});

describe('vibe display → promoting a shown document to its own tab', () => {
  it('the toolbar button opens the doc, and the tab it mints stays that doc', () => {
    mountWithShownDoc();
    fireEvent.click(screen.getByTestId('display-open-in-tab'));
    const opened = lastOpened();
    expect(opened.pointer).toContain(DOC_NAME);
    cleanup();

    const { label, reopened } = chipFor(opened);
    expect(label).toBe(DOC_NAME); // (A) the chip still names the document
    expect(reopened.pointer ?? '').toContain(DOC_NAME); // (B) it reopens the document
  });

  it('the display-history popover promotes a past display the same way', () => {
    mountWithShownDoc();
    fireEvent.click(screen.getByTestId('display-history'));
    fireEvent.click(screen.getAllByTestId('display-history-row')[0]);
    cleanup();

    const { label, reopened } = chipFor(lastOpened());
    expect(label).toBe(DOC_NAME);
    expect(reopened.pointer ?? '').toContain(DOC_NAME);
  });
});
