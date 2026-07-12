/**
 * Per-project view-mode memory (`Project.last_mode`).
 *
 * Contract under test (real backend, no mocks):
 *   1. First `loadProject` of a project with no `last_mode` stamps the current
 *      mode onto it (fire-and-forget save).
 *   2. Every effective mode switch (`setViewMode`) records onto the CURRENT
 *      project only.
 *   3. Re-entering a project applies its remembered mode.
 *   4. A garbage stored `last_mode` reads as unset — the current mode is kept
 *      and the garbage is overwritten (not laundered into Standard).
 *   5. Re-loading a project whose `last_mode` already matches performs no
 *      redundant save (backend `updated_date` stays put).
 *
 * Uses the REAL production seams: `loadProject` (the URL-first project
 * primitive every project route funnels through) and `setViewMode` (the single
 * converged mode writer). Backend state is asserted via raw entity GETs so the
 * fire-and-forget saves are observed at the source of truth, not the cache.
 */
import { instancePreferences, PrefKey, Project } from '@sdk';
import { waitFor } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';

import { loadProject } from '@src/routes/loaders/load-project';
import { getViewMode, setViewMode, ViewMode } from '@src/contexts/view-mode-context';
import { apiTestSetup, fetchRow, getTestSignupInfo } from '../utils/test-utils';

const RUN = randomUUID().slice(0, 8);

let projectA: Project;
let projectB: Project;
let initialMode: ViewMode;

/** Raw backend read — bypasses the entity cache entirely. */
const backendProject = (id: string): Promise<{ last_mode?: string | null; updated_date: unknown }> =>
  fetchRow(Project.type, id);

async function waitForBackendLastMode(id: string, expected: string): Promise<void> {
  await waitFor(
    async () => {
      const fresh = await backendProject(id);
      expect(fresh.last_mode).toBe(expected);
    },
    { timeout: 5000 },
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('per-project view-mode memory (Project.last_mode)', () => {
  beforeAll(async () => {
    await apiTestSetup(getTestSignupInfo(), 'project-view-mode-memory');
    initialMode = getViewMode();
    projectA = await new Project({ name: `view-mode-mem-A-${RUN}` }).save([]);
    projectB = await new Project({ name: `view-mode-mem-B-${RUN}` }).save([]);
  });

  afterAll(async () => {
    // Restore the global preference directly (not via setViewMode — that would
    // record onto whichever test project is still current), then drop fixtures.
    instancePreferences.set(PrefKey.VIEW_MODE, initialMode);
    await projectA?.delete().catch(() => {});
    await projectB?.delete().catch(() => {});
  });

  it('first load stamps the current mode onto a project without last_mode', async () => {
    const loaded = await loadProject(projectA.typeId);
    expect(loaded.id).toBe(projectA.id);
    await waitForBackendLastMode(projectA.id, getViewMode());
  });

  it('a mode switch records onto the current project only', async () => {
    setViewMode(ViewMode.Dev);
    await waitForBackendLastMode(projectA.id, ViewMode.Dev);
    // B was never loaded — untouched (null fields are omitted from the wire).
    expect((await backendProject(projectB.id)).last_mode ?? null).toBeNull();
  });

  it('loading another project stamps it, and its switches record there', async () => {
    await loadProject(projectB.typeId);
    // B had no last_mode → adopts (and records) the current mode.
    expect(getViewMode()).toBe(ViewMode.Dev);
    await waitForBackendLastMode(projectB.id, ViewMode.Dev);

    setViewMode(ViewMode.Vibe);
    await waitForBackendLastMode(projectB.id, ViewMode.Vibe);
    // A keeps its own memory.
    expect((await backendProject(projectA.id)).last_mode).toBe(ViewMode.Dev);
  });

  it('re-entering a project applies its remembered mode', async () => {
    expect(getViewMode()).toBe(ViewMode.Vibe);
    await loadProject(projectA.typeId);
    expect(getViewMode()).toBe(ViewMode.Dev);
    // Applying a remembered mode must not clobber the other project's memory.
    expect((await backendProject(projectB.id)).last_mode).toBe(ViewMode.Vibe);
  });

  it('garbage last_mode reads as unset: current mode kept, garbage overwritten', async () => {
    projectB.last_mode = 'bogus-mode';
    await projectB.save();
    await waitForBackendLastMode(projectB.id, 'bogus-mode');

    await loadProject(projectB.typeId);
    // Not laundered into Standard — the current mode (dev, from project A) wins…
    expect(getViewMode()).toBe(ViewMode.Dev);
    // …and replaces the garbage on the project.
    await waitForBackendLastMode(projectB.id, ViewMode.Dev);
  });

  it('re-loading a project whose last_mode already matches saves nothing', async () => {
    const before = await backendProject(projectB.id);
    expect(before.last_mode).toBe(ViewMode.Dev);

    await loadProject(projectB.typeId);
    expect(getViewMode()).toBe(ViewMode.Dev);

    // Give a hypothetical stray fire-and-forget save time to land, then assert
    // the row was not rewritten.
    await sleep(600);
    const after = await backendProject(projectB.id);
    expect(after.updated_date).toEqual(before.updated_date);
    expect(after.last_mode).toBe(ViewMode.Dev);
  });
});
