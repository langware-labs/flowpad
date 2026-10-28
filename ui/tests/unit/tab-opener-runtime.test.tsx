/**
 * The hub showed the "+" opener (New Vibe, Start Claude/Codex/…, Open terminal, history):
 * every one needs a terminal or a local session, and the hub has neither.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  openTab: vi.fn(),
  openNewChat: vi.fn(),
  record: null as unknown,
  test: vi.fn(),
  // The re-probe resolves the kind first, so a launch that failed for the
  // DEFAULT assistant is not answered by a sibling that happens to be present.
  getSnapshot: vi.fn(() => ({ resolvedKind: 'harness.claude.cli' })),
  openSources: vi.fn(),
}));

vi.mock('@src/components/llm-sources/llm-sources-pointer', () => ({
  openLlmSources: h.openSources,
  llmSourcesPointer: (w?: string) => w ?? '',
}));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openTab: h.openTab, openNewShell: vi.fn() }, currentDock: null }),
}));
vi.mock('@src/navigation/open-new-chat', () => ({ openNewChat: h.openNewChat }));
vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sdk')>()),
  capabilityManager: {
    test: h.test,
    getSnapshot: h.getSnapshot,
    // The dialog reads its install command from the summary, not the row.
    getCachedSummary: () => null,
  },
}));

// Boundaries the strip needs to mount but whose behaviour is not under test.
vi.mock('@sdk/react/hooks/useRuntimeInfo', () => ({ useRuntimeInfo: () => ({}) }));
vi.mock('@sdk/react/hooks', () => ({
  useContext: () => ({ sandboxComputeNode: null }),
  // The install dialog's own row probe — rendered here so the assertion can be
  // "the dialog is on screen", not merely "we did not redirect".
  useCapability: () => ({ capability: null, available: false, result: null, isLoading: false, test: vi.fn() }),
}));
vi.mock('@src/contexts/view-mode-context', () => ({
  useIsAdvanced: () => true,
  getEffectiveViewMode: () => 'advanced',
  ViewMode: { Advanced: 'advanced', Vibe: 'vibe' },
}));
// No status record read yet: install warnings fail open on that, so no opener carries a
// warning badge and nothing here pre-empts the path under test.
vi.mock('@src/components/workers/harness-availability', () => ({
  useHarnessAvailability: () => ({ warnings: {}, record: h.record }),
}));
vi.mock('@src/hooks/use-resume-in-terminal', () => ({ useResumeInTerminal: () => ({ resumeInTerminal: vi.fn() }) }));
vi.mock('@src/components/graph-view/icons/iconRegistry', () => ({ iconForType: () => () => null }));

import { dataContext, RuntimeKind } from '@sdk';
import { useTerminalStripController } from '@src/tabs/useTerminalStripController';

function mount(kind: RuntimeKind) {
  dataContext.bootstrapInfo = { runtime: { kind } } as never;
  let controller!: ReturnType<typeof useTerminalStripController>;
  function Probe() {
    controller = useTerminalStripController({ addTabButton: true });
    return null;
  }
  render(<Probe />);
  return controller;
}

describe('the "+" tab opener', () => {
  afterEach(() => {
    cleanup();
    dataContext.bootstrapInfo = null as never;
  });

  it('is not offered on the hub', () => {
    const c = mount(RuntimeKind.HUB);
    expect(c.trailing).toBeNull();
    expect(c.newTabMenuItems).toEqual([]);
  });

  it.each([RuntimeKind.DESKTOP, RuntimeKind.SANDBOX])('is offered on %s', (kind) => {
    const c = mount(kind);
    expect(c.trailing).not.toBeNull();
    expect(c.newTabMenuItems.length).toBeGreaterThan(0);
  });
});
