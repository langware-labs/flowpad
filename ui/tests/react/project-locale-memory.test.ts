/**
 * Per-project language memory (`Project.locale`).
 *
 * Contract under test (real backend, no mocks):
 *   1. A project with no `locale` opens in ENGLISH — it does not inherit the
 *      language of the project you came from — and is left unset, not stamped:
 *      en-US is the meaning of "no answer", not an answer the user gave.
 *   2. Every language switch (`setLocale` — the same call the footer chip and
 *      the project's Language card make) records onto the CURRENT project only.
 *   3. Re-entering a project switches the app back to its remembered language.
 *   4. An unsupported stored `locale` reads as unset — English, row untouched.
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

  it('a project with no locale opens in English, and is not stamped', async () => {
    // Start the app somewhere else entirely, so "opened in English" can only
    // come from the project, not from the language that was already active.
    await setLocale('ar');
    expect(getLocale()).toBe('ar');

    const loaded = await loadProject(projectA.typeId);
    expect(loaded.id).toBe(projectA.id);
    await waitFor(() => expect(getLocale()).toBe('en-US'));
    // `<html lang/dir>` follows one tick behind the preference — the catalog
    // import is awaited first — so wait for the DOM rather than assuming it.
    await waitFor(() => {
      expect(document.documentElement.lang).toBe('en-US');
      expect(document.documentElement.dir).toBe('ltr');
    });

    // Unset stays unset — no answer was invented on the user's behalf
    // (null fields are omitted from the wire).
    await sleep(600);
    expect((await backendProject(projectA.id)).locale ?? null).toBeNull();
  });

  it('a language switch records onto the current project only', async () => {
    await setLocale('he');
    expect(getLocale()).toBe('he');
    await waitForBackendLocale(projectA.id, 'he');
    // B was never loaded — untouched.
    expect((await backendProject(projectB.id)).locale ?? null).toBeNull();
  });

  it('entering an unset project resets to English, and its switches record there', async () => {
    await loadProject(projectB.typeId);
    // B has no locale → English, NOT project A's Hebrew.
    await waitFor(() => expect(getLocale()).toBe('en-US'));
    expect((await backendProject(projectB.id)).locale ?? null).toBeNull();

    await setLocale('ar');
    await waitForBackendLocale(projectB.id, 'ar');
    // A keeps its own memory.
    expect((await backendProject(projectA.id)).locale).toBe('he');
  });

  it('re-entering a project switches back to its remembered language', async () => {
    expect(getLocale()).toBe('ar');
    await loadProject(projectA.typeId);
    await waitFor(() => expect(getLocale()).toBe('he'));
    await waitFor(() => {
      expect(document.documentElement.lang).toBe('he');
      expect(document.documentElement.dir).toBe('rtl');
    });
    // Applying a remembered language must not clobber the other project's memory.
    expect((await backendProject(projectB.id)).locale).toBe('ar');
  });

  it('unsupported locale reads as unset: English, row left alone', async () => {
    projectB.locale = 'kl-KL';
    await projectB.save();
    await waitForBackendLocale(projectB.id, 'kl-KL');

    await loadProject(projectA.typeId); // → he
    await waitFor(() => expect(getLocale()).toBe('he'));

    await loadProject(projectB.typeId);
    // Unrecognized is treated as no answer → English, not project A's Hebrew.
    await waitFor(() => expect(getLocale()).toBe('en-US'));
    // And the row is not rewritten: we don't know what they meant, so we don't
    // guess on their behalf. Picking a language in the UI overwrites it.
    await sleep(600);
    expect((await backendProject(projectB.id)).locale).toBe('kl-KL');
  });

  it('re-loading a project whose locale already matches saves nothing', async () => {
    await setLocale('he'); // an explicit choice while B is current → stamps B
    await waitForBackendLocale(projectB.id, 'he');
    const before = await backendProject(projectB.id);

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
