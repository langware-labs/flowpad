/**
 * Per-project language memory (`Project.locale`).
 *
 * Contract under test (real backend, no mocks):
 *   1. First `loadProject` of a project with no `locale` stamps the active
 *      language onto it (fire-and-forget save).
 *   2. Every language switch (`setLocale` — the same call the footer chip and
 *      the project's Language card make) records onto the CURRENT project only.
 *   3. Re-entering a project switches the app back to its remembered language.
 *   4. An unsupported stored `locale` reads as unset — the active language is
 *      kept and the garbage is overwritten (never laundered into en-US).
 *   5. Re-loading a project whose `locale` already matches performs no
 *      redundant save (backend `updated_date` stays put).
 *
 * Mirrors `project-view-mode-memory.test.ts`: same seams (`loadProject`, the
 * single converged writer), same raw-GET assertions so the fire-and-forget
 * saves are observed at the source of truth rather than in the entity cache.
 */
import { instancePreferences, PrefKey, Project } from '@sdk';
import { waitFor } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';

import { loadProject } from '@src/routes/loaders/load-project';
import { applySupportedLocales, getLocale, setLocale } from '@src/contexts/locale-context';
import { apiTestSetup, fetchRow, getTestSignupInfo } from '../utils/test-utils';

const RUN = randomUUID().slice(0, 8);

// The supported list is backend-owned and normally installed by the root loader
// from bootstrap; these tests drive the loaders directly, so install it here.
// Same three locales the backend ships (flow_sdk/i18n/supported_locales.py).
const LOCALES = [
  { code: 'en-US', englishName: 'English', nativeName: 'English', dir: 'ltr' as const, flag: 'us' },
  { code: 'he', englishName: 'Hebrew', nativeName: 'עברית', dir: 'rtl' as const, flag: 'il' },
  { code: 'ar', englishName: 'Arabic', nativeName: 'العربية', dir: 'rtl' as const, flag: 'sa' },
];

let projectA: Project;
let projectB: Project;
let initialLocale: string;

/** Raw backend read — bypasses the entity cache entirely. */
const backendProject = (id: string): Promise<{ locale?: string | null; updated_date: unknown }> =>
  fetchRow(Project.type, id);

async function waitForBackendLocale(id: string, expected: string): Promise<void> {
  await waitFor(
    async () => {
      const fresh = await backendProject(id);
      expect(fresh.locale).toBe(expected);
    },
    { timeout: 5000 },
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('per-project language memory (Project.locale)', () => {
  beforeAll(async () => {
    await apiTestSetup(getTestSignupInfo(), 'project-locale-memory');
    await applySupportedLocales(LOCALES);
    initialLocale = getLocale();
    projectA = await new Project({ name: `locale-mem-A-${RUN}` }).save([]);
    projectB = await new Project({ name: `locale-mem-B-${RUN}` }).save([]);
  });

  afterAll(async () => {
    // Restore the global preference directly (not via setLocale — that would
    // record onto whichever test project is still current), then drop fixtures.
    instancePreferences.set(PrefKey.LOCALE, initialLocale);
    await projectA?.delete().catch(() => {});
    await projectB?.delete().catch(() => {});
  });

  it('first load stamps the active language onto a project without locale', async () => {
    const loaded = await loadProject(projectA.typeId);
    expect(loaded.id).toBe(projectA.id);
    await waitForBackendLocale(projectA.id, getLocale());
  });

  it('a language switch records onto the current project only', async () => {
    await setLocale('he');
    expect(getLocale()).toBe('he');
    await waitForBackendLocale(projectA.id, 'he');
    // B was never loaded — untouched (null fields are omitted from the wire).
    expect((await backendProject(projectB.id)).locale ?? null).toBeNull();
  });

  it('loading another project stamps it, and its switches record there', async () => {
    await loadProject(projectB.typeId);
    // B had no locale → adopts (and records) the active language.
    expect(getLocale()).toBe('he');
    await waitForBackendLocale(projectB.id, 'he');

    await setLocale('ar');
    await waitForBackendLocale(projectB.id, 'ar');
    // A keeps its own memory.
    expect((await backendProject(projectA.id)).locale).toBe('he');
  });

  it('re-entering a project switches back to its remembered language', async () => {
    expect(getLocale()).toBe('ar');
    await loadProject(projectA.typeId);
    await waitFor(() => expect(getLocale()).toBe('he'));
    expect(document.documentElement.lang).toBe('he');
    expect(document.documentElement.dir).toBe('rtl');
    // Applying a remembered language must not clobber the other project's memory.
    expect((await backendProject(projectB.id)).locale).toBe('ar');
  });

  it('unsupported locale reads as unset: active language kept, garbage overwritten', async () => {
    projectB.locale = 'kl-KL';
    await projectB.save();
    await waitForBackendLocale(projectB.id, 'kl-KL');

    await loadProject(projectB.typeId);
    // Not laundered into en-US — the active language (he, from project A) wins…
    expect(getLocale()).toBe('he');
    // …and replaces the garbage on the project.
    await waitForBackendLocale(projectB.id, 'he');
  });

  it('re-loading a project whose locale already matches saves nothing', async () => {
    const before = await backendProject(projectB.id);
    expect(before.locale).toBe('he');

    await loadProject(projectB.typeId);
    expect(getLocale()).toBe('he');

    // Give a hypothetical stray fire-and-forget save time to land, then assert
    // the row was not rewritten.
    await sleep(600);
    const after = await backendProject(projectB.id);
    expect(after.updated_date).toEqual(before.updated_date);
    expect(after.locale).toBe('he');
  });
});
