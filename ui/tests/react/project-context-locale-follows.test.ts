/**
 * The app's language must follow the CURRENT PROJECT, however it became current.
 *
 * Proven root cause (this session): `applyProjectLocale` hangs off `loadProject`
 * alone, but a project becomes current through a plain
 * `setContextEntityTypeId(CurrentProjectTypeId, …)` in ten places — including
 * `initSdk`'s `bootstrapInfo.default_project` branch (`ts_sdk/src/main.ts`),
 * which is the ONLY way a provisioned sandbox adopts the project it was made
 * for. So a box opens its Hebrew project reading English.
 *
 * ENTRY-POINT DISCLOSURE: the real scenario enters at `initSdk`. That function
 * memoises itself for the process and `apiTestSetup` has already run it, and the
 * one helper that would give a fresh module graph binds the backend through the
 * `__FLOWPAD_API_URL__` override, which this tier forbids. So the test enters one
 * frame lower, at the exact call `initSdk` makes — the same seam, with the same
 * arguments, and the seam every other loader-less project switch also uses. What
 * it cannot prove is that `initSdk` reaches that line; the instrumented run
 * already did (probe on the branch, `willAdopt: true`).
 */
import { ContextEntitiesEnum, dataContext, Project } from '@sdk';
import { waitFor } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';

import { applySupportedLocales, getLocale, setLocale } from '@src/contexts/locale-context';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

const RUN = randomUUID().slice(0, 8);

const LOCALES = [
  { code: 'en-US', englishName: 'English', nativeName: 'English', dir: 'ltr' as const, flag: 'us' },
  { code: 'he', englishName: 'Hebrew', nativeName: 'עברית', dir: 'rtl' as const, flag: 'il' },
];

let hebrew: Project;
let initialLocale: string;

describe('the app language follows the current project', () => {
  beforeAll(async () => {
    await apiTestSetup(getTestSignupInfo(), 'project-context-locale-follows');
    await applySupportedLocales(LOCALES);
    initialLocale = getLocale();
    hebrew = await new Project({ name: `ctx-he-${RUN}`, locale: 'he' }).save([]);
  });

  afterAll(async () => {
    await setLocale(initialLocale).catch(() => {});
    await hebrew?.delete().catch(() => {});
  });

  it('adopting a project as current applies its language, with no loader involved', async () => {
    await setLocale('en-US');
    await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, null);
    expect(getLocale()).toBe('en-US');

    // Exactly what `initSdk` does with `bootstrapInfo.default_project` — the
    // sandbox's own adoption. No route, no loader: this IS the boot path.
    await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, hebrew.typeId);
    dataContext.setWorkdir(hebrew.fs_storage_mount_path ?? null);

    expect(dataContext.project?.id).toBe(hebrew.id);
    await waitFor(() => expect(getLocale()).toBe('he'));
    await waitFor(() => expect(document.documentElement.dir).toBe('rtl'));
  });
});
