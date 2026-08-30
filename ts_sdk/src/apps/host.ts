/**
 * What a served app is FOR — resolved from the page's own URL, never from a
 * value written into the app.
 *
 * A webapp asset is served at `/api/v1/graph/micro_app/<id>/view/…`, so the
 * page's path already names its own delivery row. That row is an ordinary
 * asset, which means it has a parent: the asset it is nested inside. An editor
 * therefore learns what it edits by asking who contains it — the same
 * containment the address bar renders as `Project / rss / editor`.
 *
 * Nothing here is specific to editors. Any app that wants to act on the thing
 * it ships with reads its subject the same way.
 */
import { APIEntity, dataManager } from '../APIEntity';
import { TypeId } from '../models/TypeId';

/** The `micro_app` this page is being served as, from `location.pathname`. */
export function appTypeId(pathname: string = location.pathname): TypeId | null {
  const m = pathname.match(/graph\/(micro_app)\/([^/]+)\/view/i);
  return m ? new TypeId(m[1], m[2]) : null;
}

export interface AppHost {
  /** The app's own delivery row. */
  app: APIEntity<any>;
  /** The asset the app is nested inside — what it edits. Null at top level. */
  subject: APIEntity<any> | null;
}

/**
 * Resolve `{app, subject}` for the page. Throws when the page was not served as
 * a webapp asset — a wrong answer here would silently edit the wrong entity.
 */
export async function resolveAppHost(): Promise<AppHost> {
  const typeId = appTypeId();
  if (!typeId) throw new Error('not served as a webapp asset');
  const app = await dataManager.getByTypeId(typeId);
  if (!app) throw new Error(`no ${typeId}`);
  const parent = (app as any).parent_type_id;
  const subject = parent ? await dataManager.getByTypeId(new TypeId(parent)) : null;
  return { app, subject };
}

/** A query-string option the dock passed through, e.g. `?source=<id>`. */
export function appOption(name: string): string | null {
  return new URLSearchParams(location.search).get(name);
}

/**
 * Adopt the host's colour theme, from `?theme=light|dark` on this page's URL.
 *
 * A served app is cross-origin to the Flowpad window, so it cannot read the
 * `.dark` class the host writes on its own `<html>` — and `prefers-color-scheme`
 * is the OS preference, which is not the same thing as the theme the user chose
 * in the app. So the display passes it on the URL, and applying it here, before
 * first paint, is what stops a light flash inside a dark window.
 *
 * Pairs with `/sdk/flowpad.css`, which defines the palette on `:root` and
 * redefines it under `.dark`. Safe to call when neither is present: the page
 * simply stays light.
 */
export function applyHostTheme(): 'light' | 'dark' {
  // No param means nobody is hosting this page — it was opened on its own. Follow
  // the OS there rather than forcing light, so a standalone page on a dark
  // desktop does not glare.
  const param = appOption('theme');
  const prefersDark =
    typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = (param ? param === 'dark' : prefersDark) ? 'dark' : 'light';
  document.documentElement.classList.toggle('dark', theme === 'dark');
  // The URL carries the theme for the FIRST paint only — it is frozen there,
  // because the host addresses this frame by its src and re-addressing it would
  // reload the whole app to recolour it. Later changes arrive as a message, and
  // recolouring is one class flip.
  window.addEventListener('message', (event) => {
    const data = event.data as { type?: string; theme?: string } | null;
    if (data?.type !== 'flowpad:theme') return;
    document.documentElement.classList.toggle('dark', data.theme === 'dark');
  });
  return theme;
}
