/**
 * I7 — a loader redirect takes the place of the URL being loaded, and only that URL.
 *
 * Driven through a real `createBrowserRouter` with the app's `redirectHistoryStrategy`,
 * on jsdom's history, so the assertion is React Router's own history index
 * (`history.state.idx`): +1 on a push, unchanged on a replace. The reported bug:
 * open `index.md`, click a link whose URL the loader redirects (it lacks the project
 * scope), and Back skips `index.md` because the redirect replaced it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createBrowserRouter, redirect, replace } from 'react-router';
import { redirectHistoryStrategy } from '@src/routes/loaders/redirect-history';

type Router = ReturnType<typeof createBrowserRouter>;

const INDEX = '/dock/assets/index.md?scope=p1';
const UNSCOPED = '/dock/assets/plan.md';
const SCOPED = '/dock/assets/plan.md?scope=p1';

let router: Router | null = null;

/**
 * The unscoped file URL redirects to its scoped form, as `scopeAssetFileToItsProject`
 * does — once through `redirect()` and once through `replace()`: the loader's choice
 * must not matter.
 */
function startAt(url: string, helper: typeof redirect): Router {
  window.history.replaceState(null, '', url);
  router = createBrowserRouter(
    [
      {
        path: '/dock/assets/:file',
        loader: ({ request }) => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          if (!new URL(request.url).searchParams.has('scope')) throw helper(SCOPED);
          return null;
        },
        Component: () => null,
      },
    ],
    { dataStrategy: redirectHistoryStrategy },
  );
  return router;
}

async function settled(r: Router): Promise<void> {
  if (r.state.navigation.state === 'idle' && r.state.initialized) return;
  await new Promise<void>((resolve) => {
    const off = r.subscribe((s) => {
      if (s.navigation.state === 'idle' && s.initialized) {
        off();
        resolve();
      }
    });
  });
}

const idx = (): number => (window.history.state as { idx: number }).idx;
const here = (): string => window.location.pathname + window.location.search;

afterEach(() => {
  router?.dispose();
  router = null;
});

describe.each([
  ['redirect()', redirect],
  ['replace()', replace],
])('a loader that redirects with %s', (_name, helper) => {
  it('on a click: is one new entry, and Back returns to the page it was clicked from', async () => {
    const r = startAt(INDEX, helper);
    await settled(r);
    const before = idx();

    await r.navigate(UNSCOPED); // the link click: openDock → navigate(), a push

    expect(here()).toBe(SCOPED);
    expect(idx()).toBe(before + 1);

    await r.navigate(-1);
    await settled(r);
    expect(here()).toBe(INDEX);
  });

  it('on a replacing navigation: still replaces', async () => {
    const r = startAt(INDEX, helper);
    await settled(r);
    const before = idx();

    await r.navigate(UNSCOPED, { replace: true });

    expect(here()).toBe(SCOPED);
    expect(idx()).toBe(before);
  });

  it('on a cold load: replaces the landing URL instead of leaving it as a Back step', async () => {
    const r = startAt(UNSCOPED, helper);
    const before = idx();
    await settled(r);

    expect(here()).toBe(SCOPED);
    expect(idx()).toBe(before);
  });
});
