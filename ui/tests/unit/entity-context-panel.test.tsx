/**
 * Tests for EntityContextPanel — the single-entity context drawer body
 * mounted on the interactive terminal.
 *
 * Coverage:
 *  - Empty state when the entity has no shared/private context entries.
 *  - Chip-per-TypeId rendering when the entity has seeded shared context.
 *  - The "+" menu reveals the Plan and Skill items.
 *  - Picking "Plan" swaps the header into the inline title input, with the
 *    cancel button restoring the "+" button.
 *
 * The save → shareContextEntities flow is exercised via Path
 * `/api/v1/graph/<type>/<id>/share-context` in
 * tests/api/test_context_share_action.py (backend), so this file only
 * smokes the UI affordances and the data-driven chip rendering.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Spec, Task, TypeId } from '@sdk';
import { EntityContextPanel } from '@src/components/entity-context';

// useDockNavigation is consumed by both the panel and the underlying
// EntityChip — stub it so click-through doesn't try to hit the dock.
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({
    navigation: { openDock: vi.fn(), openTab: vi.fn() },
    currentDock: null,
    currentTab: null,
  }),
}));

// Sonner toast can be a noop — no UI interaction in these tests cares.
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const PROJ_ID = '11111111-aaaa-4bbb-9ccc-000000000030';
const SPEC_ID = '22222222-aaaa-4bbb-9ccc-000000000001';
const CONV_ID = '33333333-aaaa-4bbb-9ccc-000000000010';

describe('EntityContextPanel', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders both Shared and Private section headers + per-section empty hints', () => {
    // Plain Task with no buckets — both sections render their EmptyHint.
    const task = new Task({ title: 't' });
    render(<EntityContextPanel entity={task} />);
    expect(screen.getByTestId('entity-context-panel')).toBeTruthy();
    // Two section headers, matching the conversation panel's Shared / Private split.
    expect(screen.getByText(/^Shared Context$/i)).toBeTruthy();
    expect(screen.getByText(/^Private Context$/i)).toBeTruthy();
    // Per-section dashed-border empty hints.
    expect(screen.getByText(/Nothing shared on this process/i)).toBeTruthy();
    expect(screen.getByText(/Nothing in private context yet/i)).toBeTruthy();
    expect(screen.getByTestId('entity-context-panel-add')).toBeTruthy();
  });

  it('renders one row per TypeId in the merged buckets', () => {
    // Backend-computed wire payload: shared has a spec + conversation;
    // private has the project (the backend's
    // ``get_implicit_private_context_entities`` would have projected
    // ``project_id`` into the merged private list). The FE just renders
    // the arrays — it does no projection.
    const task = new Task({
      title: 't',
      project_id: PROJ_ID,
      shared_context_entities: [`spec-${SPEC_ID}`, `conversation-${CONV_ID}`],
      private_context_entities: [`project-${PROJ_ID}`],
    } as Partial<Task>);
    render(<EntityContextPanel entity={task} />);
    // Empty hints are gone now that both buckets have entries.
    expect(screen.queryByText(/Nothing shared on this process/i)).toBeNull();
    expect(screen.queryByText(/Nothing in private context yet/i)).toBeNull();
    // Type-cell labels from both sections.
    const panel = screen.getByTestId('entity-context-panel');
    const typeCells = Array.from(panel.querySelectorAll('span.shrink-0.text-muted-foreground')).map(
      (n) => n.textContent,
    );
    expect(typeCells).toContain('Spec');
    expect(typeCells).toContain('Conversation');
    expect(typeCells).toContain('Project');
  });

  it('reveals the Plan and Skill items when the + button is clicked', () => {
    const task = new Task({ title: 't' });
    render(<EntityContextPanel entity={task} />);
    fireEvent.click(screen.getByTestId('entity-context-panel-add'));
    const menu = screen.getByTestId('entity-context-panel-add-menu');
    expect(menu).toBeTruthy();
    expect(screen.getByTestId('entity-context-panel-add-spec')).toBeTruthy();
    expect(screen.getByTestId('entity-context-panel-add-skill')).toBeTruthy();
    // Menu labels: "Plan" (creates a plan-type Spec) and "Skill".
    expect(menu.textContent).toContain('Plan');
    expect(menu.textContent).toContain('Skill');
  });

  it('swaps into the inline title input when Plan is picked, and cancel restores the + button', () => {
    const task = new Task({ title: 't' });
    render(<EntityContextPanel entity={task} />);
    fireEvent.click(screen.getByTestId('entity-context-panel-add'));
    fireEvent.click(screen.getByTestId('entity-context-panel-add-spec'));
    // Title input is now visible.
    const input = screen.getByTestId('entity-context-panel-title-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.placeholder).toMatch(/Plan title/i);
    // The "+" button is hidden while the form is open.
    expect(screen.queryByTestId('entity-context-panel-add')).toBeNull();
    // Cancel restores the prior state.
    fireEvent.click(screen.getByTestId('entity-context-panel-title-cancel'));
    expect(screen.queryByTestId('entity-context-panel-title-input')).toBeNull();
    expect(screen.getByTestId('entity-context-panel-add')).toBeTruthy();
  });

  it('the submit button is disabled until the title input has non-whitespace content', () => {
    const task = new Task({ title: 't' });
    render(<EntityContextPanel entity={task} />);
    fireEvent.click(screen.getByTestId('entity-context-panel-add'));
    fireEvent.click(screen.getByTestId('entity-context-panel-add-spec'));
    const submit = screen.getByTestId('entity-context-panel-title-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('entity-context-panel-title-input'), {
      target: { value: '   ' },
    });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('entity-context-panel-title-input'), {
      target: { value: 'My plan' },
    });
    expect(submit.disabled).toBe(false);
  });

  // The Spec/Skill TypeId constructor sanity-check — keeps the test file
  // honest about which @sdk shapes we're consuming.
  it('uses Spec and TypeId from @sdk', () => {
    expect(typeof Spec.type).toBe('string');
    expect(new TypeId(Spec.type, SPEC_ID).toString()).toBe(`spec-${SPEC_ID}`);
  });
});
