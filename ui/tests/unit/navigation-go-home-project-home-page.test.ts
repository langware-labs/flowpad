import { ContextEntitiesEnum, dataContext, type Project } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { NavigationActions } from '@src/navigation/NavigationActions';
import { HOME_PAGE_OPEN, HOME_PAGE_PARAM, rememberProjectHomePage } from '@src/project-home-page/home-page-state';
import { afterEach, describe, expect, it, vi } from 'vitest';

const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = DockPointer.forShell('agentic_process-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
const ASKS_FOR_HOME_PAGE = `${HOME_PAGE_PARAM}=${HOME_PAGE_OPEN}`;

/**
 * NavigationActions.goHome and the project home page. Only the Home BUTTON
 * (`{ homePage: true }`) asks for it; the root's load redirect does the rest.
 * From the home page itself the button gives the plain home — the way out.
 */
describe('NavigationActions.goHome — project home page', () => {
  afterEach(() => {
    NavigationActions.resetPendingNavigationForTests();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  function setup(here: string) {
    window.history.pushState({}, '', here);
    vi.spyOn(dataContext, 'getContextEntity').mockImplementation((key) =>
      key === ContextEntitiesEnum.CurrentProjectTypeId ? ({ id: PROJECT_ID } as Project) : null,
    );
    const navigation = new NavigationActions(vi.fn(), null);
    const openDockSpy = vi.spyOn(navigation, 'openDock').mockImplementation(() => undefined);
    return { navigation, openDockSpy };
  }

  it('the Home button, from elsewhere → the root asking for the home page', () => {
    rememberProjectHomePage(PROJECT_ID, SESSION);
    const { navigation, openDockSpy } = setup('/dock/assets/list/all');

    navigation.goHome({ homePage: true });

    expect(openDockSpy.mock.calls[0][0].toUrl()).toContain(ASKS_FOR_HOME_PAGE);
  });

  it('the Home button, from the home page itself → the plain home', () => {
    rememberProjectHomePage(PROJECT_ID, SESSION);
    const { navigation, openDockSpy } = setup(SESSION.toUrl());

    navigation.goHome({ homePage: true });

    expect(openDockSpy.mock.calls[0][0].toUrl()).not.toContain(HOME_PAGE_PARAM);
  });

  it('any other "go home" (a fallback, not the button) → the plain home', () => {
    const { navigation, openDockSpy } = setup('/dock/assets/list/all');

    navigation.goHome();

    expect(openDockSpy.mock.calls[0][0].toUrl()).not.toContain(HOME_PAGE_PARAM);
  });
});
