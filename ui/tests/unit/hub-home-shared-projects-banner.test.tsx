/**
 * Someone invited into a project who lands on the hub home — signed in from the
 * generic login page, or from a link that did not survive — found nothing there
 * pointing at FlowPad. The home now carries a banner naming the projects other
 * people gave them, each linking to its landing page ("Open in FlowPad").
 *
 * Real banner and selection. The stand-in is the runtime (hub or desktop).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ hub: true }));

vi.mock('@src/navigation/hub-runtime', () => ({ isHubOnly: () => h.hub }));

import { SharedProjectsBanner, sharedProjectsToOpen } from '@src/pages/hub-home/SharedProjectsBanner';

const ME = 'user-eran';
const GADI = 'user-gadi';
const project = (id: string, over: Record<string, unknown> = {}) =>
  ({
    id,
    name: `Course ${id}`,
    hidden: false,
    created_by: GADI,
    updated_date: '2026-10-05T12:00:00Z',
    ...over,
  }) as never;

const renderBanner = (projects: never[]) =>
  render(
    <MemoryRouter>
      <SharedProjectsBanner projects={projects} />
    </MemoryRouter>,
  );

describe('sharedProjectsToOpen', () => {
  it('keeps projects someone else created, newest first', () => {
    const rows = [
      project('old', { updated_date: '2026-10-01T00:00:00Z' }),
      project('new', { updated_date: '2026-10-05T00:00:00Z' }),
    ];

    expect(sharedProjectsToOpen(rows, ME).map((p) => p.id)).toEqual(['new', 'old']);
  });

  it('leaves out my own projects and app-managed ones', () => {
    const rows = [project('mine', { created_by: ME }), project('system', { hidden: true }), project('shared')];

    expect(sharedProjectsToOpen(rows, ME).map((p) => p.id)).toEqual(['shared']);
  });

  it('keeps a row with no creator — a nudge too many beats none', () => {
    expect(sharedProjectsToOpen([project('anon', { created_by: undefined })], ME)).toHaveLength(1);
  });

  it('is empty before the list loads', () => {
    expect(sharedProjectsToOpen(undefined, ME)).toEqual([]);
  });
});

describe('SharedProjectsBanner', () => {
  beforeEach(() => {
    h.hub = true;
  });
  afterEach(() => cleanup());

  it('links each project to its landing page', () => {
    renderBanner([project('269b8338')]);

    const link = screen.getByTestId('hub-home-shared-project-269b8338');
    expect(link.getAttribute('href')).toBe('/project/269b8338');
    expect(link.textContent).toBe('Course 269b8338');
    expect(screen.getByText(/Open your shared projects in FlowPad/)).toBeTruthy();
  });

  it('names three projects and counts the rest', () => {
    renderBanner(['a', 'b', 'c', 'd', 'e'].map((id) => project(id)));

    expect(screen.getAllByTestId(/^hub-home-shared-project-/)).toHaveLength(3);
    expect(screen.getByText(/\+2 more/)).toBeTruthy();
  });

  it('shows nothing when there is no shared project', () => {
    renderBanner([]);

    expect(screen.queryByTestId('hub-home-shared-projects')).toBeNull();
  });

  it('shows nothing on a desktop backend, which has no landing page to link to', () => {
    h.hub = false;

    renderBanner([project('269b8338')]);

    expect(screen.queryByTestId('hub-home-shared-projects')).toBeNull();
  });

  it('falls back to a name for a project that has none', () => {
    renderBanner([project('269b8338', { name: null })]);

    expect(screen.getByTestId('hub-home-shared-project-269b8338').textContent).toBe('Untitled project');
  });
});
