import { NavigationActions } from '@src/navigation/NavigationActions';
import { afterEach, describe, expect, it, vi } from 'vitest';

const position = vi.hoisted(() => ({ canGoBack: false, canGoForward: false, idx: 0 }));
vi.mock('@src/navigation/history-position-store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getHistoryPosition: () => position,
}));

/** `backOrHome`: a screen is never a dead end — back when this tab has history, else Home. */
describe('NavigationActions.backOrHome', () => {
  afterEach(() => {
    NavigationActions.resetPendingNavigationForTests();
    vi.restoreAllMocks();
  });

  function setup(canGoBack: boolean) {
    position.canGoBack = canGoBack;
    const navigation = new NavigationActions(vi.fn(), null);
    const goBack = vi.spyOn(navigation, 'goBack').mockImplementation(() => undefined);
    const goHome = vi.spyOn(navigation, 'goHome').mockImplementation(() => undefined);
    navigation.backOrHome();
    return { goBack, goHome };
  }

  it('steps back when there is history', () => {
    const { goBack, goHome } = setup(true);
    expect(goBack).toHaveBeenCalledOnce();
    expect(goHome).not.toHaveBeenCalled();
  });

  it('goes Home on a screen loaded straight from a link', () => {
    const { goBack, goHome } = setup(false);
    expect(goHome).toHaveBeenCalledOnce();
    expect(goBack).not.toHaveBeenCalled();
  });
});
