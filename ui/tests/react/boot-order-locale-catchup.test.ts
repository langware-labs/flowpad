/**
 * Boot ORDER: the project is already current before the locale list arrives.
 *
 * `loadRoot` is `await initSdk()` then `await applySupportedLocales(…)`, and
 * `initSdk` adopts `bootstrapInfo.default_project` — so on a provisioned box the
 * `CurrentProjectTypeId` write happens BEFORE the locale subsystem is listening
 * for it. A subscription alone therefore never sees the one event it exists for;
 * it has to reconcile whatever project is ALREADY current at install time.
 *
 * This is the hole the first version of the fix had, caught by a real sandbox:
 * the box's project carried `locale='he'`, the box ran the fixed build, and it
 * still opened in English.
 */
import { ContextEntitiesEnum, dataContext, instancePreferences, PrefKey, Project } from '@sdk';
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

describe('boot order: project adopted before the locale list lands', () => {
  beforeAll(async () => {
    await apiTestSetup(getTestSignupInfo(), 'boot-order-locale-catchup');
    await applySupportedLocales(LOCALES);
    initialLocale = getLocale();
    hebrew = await new Project({ name: `bootorder-he-${RUN}`, locale: 'he' }).save([]);
  });

  afterAll(async () => {
    await setLocale(initialLocale).catch(() => {});
    await hebrew?.delete().catch(() => {});
  });

  it('applies the language of a project that is ALREADY current, with no context event', async () => {
    // Put the Hebrew project in context first, as `initSdk` does.
    await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, null);
    await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, hebrew.typeId);
    expect(dataContext.project?.id).toBe(hebrew.id);

    // Now force the app back to English WITHOUT a context change, so no
    // subscription can fire. This reproduces the boot state a box is in when the
    // locale subsystem comes up: the project is current, the app is not in its
    // language, and the event that would have said so is already in the past.
    // (Deliberately not `setLocale`, which would stamp en-US onto the project.)
    instancePreferences.set(PrefKey.LOCALE, 'en-US');
    await waitFor(() => expect(getLocale()).toBe('en-US'));

    // `loadRoot` step 2 — the backend's locale list arrives. From here the
    // project's language IS resolvable, so this is the moment it must be applied.
    await applySupportedLocales(LOCALES);

    await waitFor(() => expect(getLocale()).toBe('he'));
  });
});
