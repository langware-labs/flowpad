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
