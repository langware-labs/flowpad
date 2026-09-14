/**
 * What invokes a wizard, shown from CONTAINMENT.
 *
 * The previous version walked the document's `triggers[]` and re-derived the
 * backend's `wizard_<slug>_<index>` uname in TypeScript to find each row. That
 * algorithm lived in two languages and was keyed POSITIONALLY, so reordering a
 * wizard's triggers matched the wrong rows and swapped their fire counts. The
 * relationship is containment, and `parent_type_id` is where it already lives.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ openDock: vi.fn() }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: nav, currentDock: null }),
}));

const rows = vi.hoisted(() => ({ triggers: [] as Record<string, unknown>[] }));
vi.mock('@src/hooks/entity-hooks', () => ({
  useEntitiesQuery: () => ({ data: rows.triggers, isLoading: false, error: null }),
  useEntity: () => ({ data: null, isLoading: false, error: null }),
}));

import { WizardForm } from '@src/components/assets/editor/wizard/WizardForm';

const WIZARD_KEY = 'wizard-550e8400-e29b-41d4-a716-446655440000';
const wizard = { typeId: { toString: () => WIZARD_KEY }, name: 'w' } as never;

afterEach(() => {
  cleanup();
  rows.triggers = [];
  vi.clearAllMocks();
});

function renderForm() {
  render(
    <WizardForm
      doc={{ name: 'w', steps: [] }}
      wizard={wizard}
      commit={vi.fn()}
      validation={null}
      saveError={null}
      saving={false}
      readOnly={false}
    />,
  );
}

describe('the wizard trigger section', () => {
  it('shows the triggers that live INSIDE this wizard', () => {
    rows.triggers = [
      { id: 't1', parent_type_id: WIZARD_KEY, tag_pattern: 'app.ready', fire_once: true, counter: 1 },
      // A trigger belonging to a different asset must not appear here.
      { id: 't2', parent_type_id: 'wizard-other', tag_pattern: 'ingest.done', counter: 0 },
    ];
    renderForm();

    expect(screen.getByTestId('wizard-trigger-0').textContent).toContain('app.ready');
    expect(screen.queryByTestId('wizard-trigger-1')).toBeNull();
    expect(screen.queryByText('ingest.done')).toBeNull();
  });

  it('reads the fire count off the ROW, which is the only place it exists', () => {
    rows.triggers = [{ id: 't1', parent_type_id: WIZARD_KEY, tag_pattern: 'app.ready', counter: 3 }];
    renderForm();
    expect(screen.getByTestId('wizard-trigger-fired-0').textContent).toContain('3');

    cleanup();
    rows.triggers = [{ id: 't1', parent_type_id: WIZARD_KEY, tag_pattern: 'app.ready', counter: 0 }];
    renderForm();
    expect(screen.getByTestId('wizard-trigger-fired-0').textContent).toMatch(/not fired/i);
  });

  it('says where to put one when the wizard has none', () => {
    renderForm();
    // Names the folder, because that IS the answer and it is not discoverable
    // from this screen.
    expect(screen.getByTestId('wizard-no-triggers').textContent).toContain('agentic-assets/trigger/');
  });

  it('opens the trigger with system scope, or the link lands on an empty list', () => {
    rows.triggers = [{ id: 't1', parent_type_id: WIZARD_KEY, tag_pattern: 'app.ready' }];
    renderForm();

    fireEvent.click(screen.getByTestId('wizard-trigger-open-0'));

    expect(nav.openDock).toHaveBeenCalledTimes(1);
    const pointer = nav.openDock.mock.calls[0][0] as { options?: Record<string, string> };
    expect(pointer.options?.trigger).toBe('t1');
    // A wizard's trigger is system-scoped; without this the Events screen hides
    // it and "Open trigger" arrives at nothing.
    expect(pointer.options?.system).toBe('1');
  });
});
