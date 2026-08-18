/**
 * Switching project from the VIBE home applies the destination's language.
 *
 * The regression this pins: the vibe branch of `setCurrentProjectContext` used
 * to write `CurrentProjectTypeId` itself and *then* navigate. That disarmed the
 * loader — `adoptScopeProject` skips when `dataContext.project?.id` already
 * equals the URL's project — so `loadProject` never ran on a vibe switch, and
 * everything hanging off it (the project's remembered language, its view mode)
 * silently did not happen. You switched from a Hebrew project to an English one
 * and stayed in Hebrew.
 *
 * So this test enters through the REAL loader the vibe switch navigates to
 * (`loadHomePage` for `/?vibeNoProcess=true&scope-mode=project&scope-activeProjectId=…`)
 * with context in the state the click path leaves it in. Calling
 * `applyProjectLocale` directly would pass against the bug — the bug is that
 * nothing calls it.
 */
import { ContextEntitiesEnum, dataContext, Project } from '@sdk';
import { waitFor } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';

import { loadProject } from '@src/routes/loaders/load-project';
import { loadHomePage } from '@src/routes/loaders/home-loader';
import { applySupportedLocales, getLocale, setLocale } from '@src/contexts/locale-context';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

const RUN = randomUUID().slice(0, 8);

const LOCALES = [
  { code: 'en-US', englishName: 'English', nativeName: 'English', dir: 'ltr' as const, flag: 'us' },
  { code: 'he', englishName: 'Hebrew', nativeName: 'עברית', dir: 'rtl' as const, flag: 'il' },
];

let hebrew: Project;
let english: Project;
let initialLocale: string;

/** The URL the vibe home switch navigates to. */
const vibeHomeUrl = (projectId: string) =>
  `http://localhost/?vibeNoProcess=true&scope-mode=project&scope-activeProjectId=${projectId}&viewMode=vibe`;

async function runHomeLoader(projectId: string): Promise<void> {
  try {
    await loadHomePage({ request: new Request(vibeHomeUrl(projectId)), params: {}, context: {} } as never);
  } catch {
    // The loader may throw a redirect (load-redirects); irrelevant here.
  }
}

describe('vibe home project switch applies the destination language', () => {
  beforeAll(async () => {
    await apiTestSetup(getTestSignupInfo(), 'vibe-switch-project-locale');
    await applySupportedLocales(LOCALES);
    initialLocale = getLocale();
    hebrew = await new Project({ name: `vibe-he-${RUN}`, locale: 'he' }).save([]);
    english = await new Project({ name: `vibe-en-${RUN}`, locale: 'en-US' }).save([]);
  });

  afterAll(async () => {
    await setLocale(initialLocale).catch(() => {});
    await hebrew?.delete().catch(() => {});
    await english?.delete().catch(() => {});
  });

  it('switches out of Hebrew when the destination project is English', async () => {
    // Sitting in the Hebrew project, app in Hebrew.
    await loadProject(hebrew.typeId);
    await waitFor(() => expect(getLocale()).toBe('he'));

    // The vibe switcher's own step: it clears the stale process/active entity
    // and navigates. It must NOT pre-write the project — that is what silently
    // disabled the loader.
    await dataContext.setActiveEntityTypeId(null);
    await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProcessTypeId, null);
    await runHomeLoader(english.id);

    await waitFor(() => expect(getLocale()).toBe('en-US'));
    expect(dataContext.project?.id).toBe(english.id);
    await waitFor(() => expect(document.documentElement.dir).toBe('ltr'));
  });

  it('and back into Hebrew when the destination project is Hebrew', async () => {
    await runHomeLoader(hebrew.id);

    await waitFor(() => expect(getLocale()).toBe('he'));
    expect(dataContext.project?.id).toBe(hebrew.id);
    await waitFor(() => expect(document.documentElement.dir).toBe('rtl'));
  });

  it('switching away and back is not a no-op the second time', async () => {
    // Guards the shape of the original bug rather than one instance of it: the
    // loader short-circuits when the URL's project is already current, so a
    // switch must always leave context pointing at the DESTINATION. If anything
    // in the click path starts pre-writing it again, the second lap here is the
    // one that stops switching language.
    await runHomeLoader(english.id);
    await waitFor(() => expect(getLocale()).toBe('en-US'));

    await runHomeLoader(hebrew.id);
    await waitFor(() => expect(getLocale()).toBe('he'));

    await runHomeLoader(english.id);
    await waitFor(() => expect(getLocale()).toBe('en-US'));
    expect(dataContext.project?.id).toBe(english.id);
  });
});
