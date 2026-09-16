/**
 * A project CREATED here is born in the language the app is showing.
 *
 * `applyProjectLocale` treats an unset `Project.locale` as "no answer" and opens
 * in English rather than inheriting the last project's language — right for
 * ENTERING a project, wrong for MAKING one. Cloning a repo from a Hebrew app and
 * landing in English is the symptom that motivated this: making the project in
 * Hebrew IS the answer.
 *
 * Pins the seed at all three local creation sites, because the failure shape
 * here is never "the helper is wrong", it is "nothing calls it":
 *   1. `useEnsureProject`      — QuickCreate / Home `+` → new Project(...)
 *   2. `useProjectOpener`      — open a folder from disk → new Project(...)
 *   3. `useCloneGitProjectAndOpen` — git clone, where the BACKEND mints the row
 *
 * And the boundary: a project that arrives with a locale of its own (a hub
 * shared/remote project) keeps it. Only an unanswered row gets seeded.
 */
import { renderHook } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const openDock = vi.hoisted(() => vi.fn());
const openShellProcess = vi.hoisted(() => vi.fn());
const selectProjectContextMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ currentDock: null, navigation: { openDock, openShellProcess } }),
  useIsHomeSurface: () => true,
}));
vi.mock('@src/contexts/view-mode-context', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useIsVibe: () => true,
}));
// Override ONLY the context writer; `useEnsureProject` / `useCloneGitProjectAndOpen`
// live in this module and are the code under test.
vi.mock('@src/components/project-selector', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  selectProjectContext: selectProjectContextMock,
}));
vi.mock('@src/tabs/project-entry', () => ({
  agenticProcessIdForProjectEntry: vi.fn(() => Promise.resolve(null)),
  dockForProjectEntry: vi.fn(),
}));
vi.mock('@src/components/agent-layout/agent-layout', () => ({
  useAgentContext: () => ({ computeNode: null }),
}));
vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn() } }));

import { dataContext, instancePreferences, lazyAssets, PrefKey, Project, type TypeId } from '@sdk';
import { applySupportedLocales } from '@src/contexts/locale-context';
import { useEnsureProject, useCloneGitProjectAndOpen } from '@src/components/project-selector';
import { useProjectOpener } from '@src/components/open-project-component/use-open-project';

const LOCALES = [
  { code: 'en-US', englishName: 'English', nativeName: 'English', dir: 'ltr' as const, flag: 'us' },
  { code: 'he', englishName: 'Hebrew', nativeName: 'עברית', dir: 'rtl' as const, flag: 'il' },
  { code: 'ar', englishName: 'Arabic', nativeName: 'العربية', dir: 'rtl' as const, flag: 'sa' },
];

const PATH = '/proj/brand-new';

let initialLocale: string;

/**
 * Put the app in `code` and let the switch finish. The preference write is the
 * real seam (footer chip, Language card and the boot restore all land on it),
 * but `onPrefLocaleChanged` answers it by loading a catalog off a dynamic
 * import — unawaited, it resolves after teardown and touches `document`.
 */
async function appInLanguage(code: string): Promise<void> {
  instancePreferences.set(PrefKey.LOCALE, code);
  await new Promise((r) => setTimeout(r, 50));
}

/** The row the backend hands back from a clone, plus a handle on its `save`. */
function mintedProject(locale: string | null = null) {
  const save = vi.fn(() => Promise.resolve(project));
  const project = {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    name: PATH,
    fs_storage_mount_path: PATH,
    locale,
    save,
    setupForDesktop: vi.fn(() => Promise.resolve()),
  } as unknown as Project;
  return { project, save };
}

describe('a new project is born in the app’s current language', () => {
  beforeAll(async () => {
    await applySupportedLocales(LOCALES);
    initialLocale = instancePreferences.get(PrefKey.LOCALE) as string;
  });

  afterAll(async () => {
    await appInLanguage(initialLocale ?? 'en-US');
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    // The app is in Hebrew — the state the whole bug is about.
    await appInLanguage('he');
    vi.spyOn(dataContext, 'getContextEntityTypeId').mockReturnValue({ id: 'user' } as unknown as TypeId);
    vi.spyOn(dataContext, 'setActiveEntityTypeId').mockResolvedValue(undefined as never);
    vi.spyOn(dataContext, 'setContextEntityTypeId').mockResolvedValue(undefined as never);
    vi.spyOn(dataContext, 'refreshProject').mockResolvedValue(undefined as never);
    vi.spyOn(dataContext, 'setWorkdir').mockImplementation(() => {});
    // Nothing at this path yet, so every opener takes its CREATE branch.
    vi.spyOn(lazyAssets, 'refresh').mockResolvedValue([]);
    vi.spyOn(Project.prototype, 'setupForDesktop').mockResolvedValue(undefined as never);
  });

  /** The project handed to `save()` by whichever create path just ran. */
  function captureSaved(): { get: () => Project | undefined } {
    const spy = vi.spyOn(Project.prototype, 'save').mockImplementation(function (this: Project) {
      return Promise.resolve(this);
    });
    return { get: () => spy.mock.instances[0] as Project | undefined };
  }

  it('useEnsureProject — QuickCreate / Home + creates it in Hebrew', async () => {
    const saved = captureSaved();
    const { result } = renderHook(() => useEnsureProject());

    await result.current(PATH);

    expect(saved.get()?.locale).toBe('he');
  });

  it('useProjectOpener — opening a folder from disk creates it in Hebrew', async () => {
    const saved = captureSaved();
    const { result } = renderHook(() => useProjectOpener());

    await result.current.ensureProjectAndSetContext(PATH);

    expect(saved.get()?.locale).toBe('he');
  });

  it('git clone — the BACKEND-minted row is stamped before the caller lands on it', async () => {
    const { project, save } = mintedProject();
    vi.spyOn(Project, 'createFromGitUrl').mockResolvedValue({ kind: 'ok', project });
    const land = vi.fn(() => Promise.resolve());
    const { result } = renderHook(() => useCloneGitProjectAndOpen(land));

    await result.current('node-1', 'https://github.com/langware-labs/hello-flowpad-task');

    expect(project.locale).toBe('he');
    expect(save).toHaveBeenCalled();
    // Order matters: `land` adopts the project and `applyProjectLocale` reads
    // `locale` off it. Seeded after the landing, the clone still opens English.
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(land.mock.invocationCallOrder[0]);
  });

  it('a clone that ALREADY has a language (hub shared/remote) keeps it', async () => {
    const { project, save } = mintedProject('ar');
    vi.spyOn(Project, 'createFromGitUrl').mockResolvedValue({ kind: 'ok', project });
    const { result } = renderHook(() => useCloneGitProjectAndOpen(vi.fn(() => Promise.resolve())));

    await result.current('node-1', 'https://github.com/langware-labs/hello-flowpad-task');

    expect(project.locale).toBe('ar');
    expect(save).not.toHaveBeenCalled();
  });

  it('English app → English project: the seed is the ACTIVE language, not a constant', async () => {
    await appInLanguage('en-US');
    const saved = captureSaved();
    const { result } = renderHook(() => useEnsureProject());

    await result.current(PATH);

    expect(saved.get()?.locale).toBe('en-US');
  });
});
