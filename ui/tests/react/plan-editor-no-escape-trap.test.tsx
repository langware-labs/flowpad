/**
 * RCA repro (Plan tab stuck — no close/escape in the editor): when a PLAN dock
 * pointer resolves to an EMPTY file path, PlanFileEditor takes the
 * `if (!filePath)` early return (SpecEditor.tsx:225-231) and renders ONLY a
 * spinner — the top action bar (which holds the Cancel/"go back" button,
 * SpecEditor.tsx:317-327) is never reached, so the user has no way out of the
 * tab.
 *
 * Proven switch (see RCA this session): `filePath`.
 *   - vfs pointer WITH a sub-path → filePath truthy → full action bar + Cancel.
 *   - vfs pointer WITHOUT a sub-path (`vfs/compute_node-@local/`) →
 *     VFSPath.machinePath === '' → filePath empty → bare-spinner early return,
 *     no escape control.
 *
 * Faithful, no-mock: the REAL SpecEditor is mounted under the REAL react-router
 * route + the REAL useDockNavigation, so `currentDock` is parsed from the URL
 * exactly as in production. The only input is the dock URL — the same lever a
 * stale bookmark / mis-minted plan tab carries.
 */
import '@src/i18n-init';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { SpecEditor } from '@src/components/spec-editor/SpecEditor';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';

function mountPlan(pointer: string) {
  return render(
    <I18nProvider i18n={i18n}>
      <MemoryRouter initialEntries={[`/dock/plan/${pointer}`]}>
        <Routes>
          <Route path="dock/:viewType/*" element={<SpecEditor />} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

const escapeControl = () =>
  screen.queryByRole('button', { name: /cancel|go back|back|close/i });

describe('Plan editor escape hatch (SpecEditor.tsx:225 no-escape early return)', () => {
  it('SWITCH ON: vfs pointer WITH sub-path → filePath truthy → Cancel button is rendered', () => {
    mountPlan('vfs/compute_node-@local/Users/x/.flow/plan.md');
    expect(escapeControl()).toBeInTheDocument();
  });

  it('SWITCH OFF (bug): vfs pointer WITHOUT sub-path → filePath empty → user is TRAPPED (no escape control)', () => {
    // pointer = `vfs/compute_node-@local/` → VFSPath.machinePath === '' → the
    // editor renders the bare spinner with no action bar. The user must have a
    // way out — this assertion fails today (the bug) and passes once the
    // early-return branch renders a Go Back / Cancel affordance.
    mountPlan('vfs/compute_node-@local/');
    expect(escapeControl()).toBeInTheDocument();
  });
});
