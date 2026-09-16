/**
 * Per-project view-mode memory (`Project.last_mode`).
 *
 * Contract under test (real backend, no mocks):
 *   1. Loading a project writes no memory: opening something only displays a
 *      mode; `last_mode` is minted by a mode SWITCH (VIEW_MODE_STORE).
 *   2. Every mode switch (`setViewMode`) records onto the CURRENT project only.
 *   3. Loading a project neither applies nor rewrites its memory; the remembered
 *      mode reaches the screen through the URL — a project dock's seed reads it
 *      (`rememberedDockViewMode`).
 *   4. A garbage stored `last_mode` reads as no memory, and the next switch
 *      replaces it (it is not laundered into Standard).
 *   5. Re-loading a project saves nothing (backend `updated_date` stays put).
 *
 * Uses the REAL production seams: `loadProject` (the URL-first project
 * primitive every project route funnels through), `setViewMode` (the one mode
 * switch) and `rememberedDockViewMode` (what `openDock` seeds a dock with).
 * Backend state is asserted via raw entity GETs so the fire-and-forget saves are
 * observed at the source of truth, not the cache.
 */
import { instancePreferences, PrefKey, Project } from '@sdk';
import { waitFor } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';

import { loadProject } from '@src/routes/loaders/load-project';
import { DockPointer } from '@src/navigation/DockPointer';
import { getViewMode, rememberedDockViewMode, setViewMode, ViewMode } from '@src/contexts/view-mode-context';
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

/** Give a hypothetical stray fire-and-forget save time to land. */
const STRAY_SAVE_MS = 600;

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

  it('loading a project writes no memory', async () => {
    const loaded = await loadProject(projectA.typeId);
    expect(loaded.id).toBe(projectA.id);

    await sleep(STRAY_SAVE_MS);
    // Null fields are omitted from the wire.
    expect((await backendProject(projectA.id)).last_mode ?? null).toBeNull();
  });

  it('a mode switch records onto the current project only', async () => {
    setViewMode(ViewMode.Dev);
    await waitForBackendLastMode(projectA.id, ViewMode.Dev);
    // B was never loaded — untouched.
    expect((await backendProject(projectB.id)).last_mode ?? null).toBeNull();
  });

  it('switches after loading another project record there', async () => {
    await loadProject(projectB.typeId);
    // Loading displays nothing new: the current mode is unchanged and B stays empty.
    expect(getViewMode()).toBe(ViewMode.Dev);

    setViewMode(ViewMode.Vibe);
    await waitForBackendLastMode(projectB.id, ViewMode.Vibe);
    // A keeps its own memory.
    expect((await backendProject(projectA.id)).last_mode).toBe(ViewMode.Dev);
  });

  it('re-entering a project does not apply or rewrite its memory; its dock seeds from it', async () => {
    expect(getViewMode()).toBe(ViewMode.Vibe);
    await loadProject(projectA.typeId);
    // The loader applies nothing — the mode reaches the screen through the URL.
    expect(getViewMode()).toBe(ViewMode.Vibe);
    expect(rememberedDockViewMode(DockPointer.forProject(projectA.id))).toBe(ViewMode.Dev);

    await sleep(STRAY_SAVE_MS);
    expect((await backendProject(projectA.id)).last_mode).toBe(ViewMode.Dev);
    expect((await backendProject(projectB.id)).last_mode).toBe(ViewMode.Vibe);
  });

  it('garbage last_mode reads as no memory, and the next switch replaces it', async () => {
    projectB.last_mode = 'bogus-mode';
    await projectB.save();
    await waitForBackendLastMode(projectB.id, 'bogus-mode');

    await loadProject(projectB.typeId);
    // Not laundered into Standard — it is simply no memory.
    expect(rememberedDockViewMode(DockPointer.forProject(projectB.id))).toBeNull();

    setViewMode(ViewMode.Advanced);
    await waitForBackendLastMode(projectB.id, ViewMode.Advanced);
  });

  it('re-loading a project saves nothing', async () => {
    const before = await backendProject(projectB.id);
    expect(before.last_mode).toBe(ViewMode.Advanced);

    await loadProject(projectB.typeId);

    await sleep(STRAY_SAVE_MS);
    const after = await backendProject(projectB.id);
    expect(after.updated_date).toEqual(before.updated_date);
    expect(after.last_mode).toBe(ViewMode.Advanced);
  });
});
