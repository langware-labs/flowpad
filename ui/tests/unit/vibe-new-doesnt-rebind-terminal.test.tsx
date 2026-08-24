import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessKind } from '@sdk';

/**
 * FLOWPAD-2027 regression.
 *
 * Vibe's "New" pill (`vibe-chat-pane.tsx`, `data-testid="entity-execution-new"`)
 * wires straight into `EntityExecutionPanel`'s `startNewSession` (the
 * `leadingSlot` render-prop contract). Root cause proven by static trace:
 * `startNewSession` (EntityExecutionPanel.tsx) ONLY resets local composer
 * state (`forceNew`, `selectedProcessId`, `localProcess`) — it never creates
 * an `AgenticProcess` and never navigates. Real process creation (and the
 * `navigation.openShellProcess` call that rebinds the workspace URL/dock) is
 * deferred to `handleSend`'s lazy-create path, which only runs once the user
 * actually submits a prompt.
 *
 * Because the Terminal view mode reads the SAME dock pointer
 * (`ViewToggle.select` → `currentDock.withViewMode(next)`, which copies the
 * pointer unchanged — DockPointer.ts), switching to Terminal right after
 * "New" (before typing anything) mounts whatever process the dock still
 * points at — i.e. the old, already-used session, not a new one.
 *
 * This test drives the REAL `EntityExecutionPanel` (the component the bug
 * lives in) through its REAL "New" button, exactly as `VibeChatPane` wires
 * it — only its unrelated sub-widgets (composer, settings popover, message
 * list, plan bar, …) are stubbed so the panel can mount without a live
 * backend. It is a proxy for the cross-surface symptom (Terminal reusing the
 * old process): it proves the specific fact that makes that possible — a
 * "New" click performs ZERO process creation and ZERO navigation, so
 * whatever the dock/URL pointed at before the click is still what it points
 * at after.
 */

vi.mock('@src/components/entity-execution-panel/CompactExecutionInput', () => ({
  CompactExecutionInput: () => <div data-testid="compact-input-stub" />,
}));
vi.mock('@src/components/entity-execution-panel/ExecutionSettingsPopover', () => ({
  ExecutionSettingsPopover: () => null,
}));
vi.mock('@src/components/entity-execution-panel/ProcessNameBar', () => ({
  ProcessNameBar: () => null,
}));
vi.mock('@src/components/entity-execution-panel/QueueChip', () => ({
  QueueChip: () => null,
}));
vi.mock('@src/components/entity-execution-panel/ChatActivityLine', () => ({
  ChatActivityLine: () => null,
}));
vi.mock('@src/components/entity-execution-panel/TurnGroupsList', () => ({
  TurnGroupsList: () => null,
}));
vi.mock('@src/components/entity-execution-panel/execution-message/execution-message', () => ({
  default: () => null,
}));
vi.mock('@src/components/floating-chat/TurnEventChip', () => ({
  TurnEventChip: () => null,
}));
vi.mock('@src/components/terminal/interactive-terminal/chat-plan-mode-context', () => ({
  ChatPlanModeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@src/components/terminal/interactive-terminal/PlanInteractionBar', () => ({
  PlanInteractionBar: () => null,
}));
vi.mock('@src/components/asset-manager', () => ({
  AssetManagerButton: () => null,
}));
// No pre-existing process for this target — isolates the click itself (no
// dataManager/network needed for the history list).
vi.mock('@src/components/entity-execution-panel/hooks/useProcessesForTarget', () => ({
  useProcessesForTarget: () => ({ processes: [], isLoading: false }),
}));

import { EntityExecutionPanel } from '@src/components/entity-execution-panel';

afterEach(() => {
  cleanup();
});

// jsdom doesn't implement smooth-scroll; AutoScrollContainer calls it on mount.
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = vi.fn();
}

describe('EntityExecutionPanel "New" (Vibe leadingSlot contract) — FLOWPAD-2027', () => {
  it('creates a new session and rebinds navigation when the real New button is clicked', async () => {
    const createProcess = vi.fn().mockResolvedValue({ id: 'p-new', enableAssistant: vi.fn() });
    const onProcessCreated = vi.fn();

    render(
      <EntityExecutionPanel
        target="markdown-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        processType={ProcessKind.Chat}
        createProcess={createProcess}
        onProcessCreated={onProcessCreated}
        // The exact "New" pill VibeChatPane renders (vibe-chat-pane.tsx:123-134).
        leadingSlot={({ startNewSession }) => (
          <button type="button" onClick={startNewSession} data-testid="entity-execution-new">
            New
          </button>
        )}
      />,
    );

    fireEvent.click(screen.getByTestId('entity-execution-new'));

    // A "New" click must actually start a fresh session — otherwise the dock
    // pointer the Terminal view reads never moves off the old process, and
    // switching to Terminal without typing anything lands the user back in
    // the already-used session (FLOWPAD-2027).
    expect(createProcess, 'New must eagerly create a fresh AgenticProcess').toHaveBeenCalled();
    expect(onProcessCreated, 'the new process must be handed to the host so it can rebind the workspace URL').toHaveBeenCalled();
  });
});
