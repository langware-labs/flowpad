import { WorldViewProjection, isWorldViewProjection } from '@sdk';

function canonicalSearch(search: string, focus?: string, allowSignal = true): string {
  const params = new URLSearchParams(search);
  const legacyColor = params.get('color');
  if (legacyColor && !params.has('signal')) params.set('signal', legacyColor);
  params.delete('color');
  if (!allowSignal) params.delete('signal');
  if (focus) params.set('focus', focus);

  const hidden = params.get('hide');
  if (hidden) {
    const normalized = [
      ...new Set(
        hidden
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ]
      .sort()
      .join(',');
    if (normalized) params.set('hide', normalized);
    else params.delete('hide');
  }

  const query = params.toString();
  return query ? `?${query}` : '';
}

/**
 * Collapse the retired Atlas and entity-rooted WorldView URL families into the
 * one projection-first WorldView grammar. Pure: the root loader owns the
 * redirect, so mounted views only ever observe canonical URL state.
 */
export function canonicalWorldViewDockPath(pathname: string, search: string): string | null {
  const atlasMatch = pathname.match(/^(.*\/(?:dock|dev|win))\/hub\/atlas(?:\/([^/]+))?\/?$/);
  if (atlasMatch) {
    const projection =
      atlasMatch[2] === WorldViewProjection.ORGANIZATION ? WorldViewProjection.ORGANIZATION : WorldViewProjection.WORLD;
    return `${atlasMatch[1]}/hub/worldview/${projection}${canonicalSearch(search, undefined, false)}`;
  }

  const hubMatch = pathname.match(/^(.*\/(?:dock|dev|win))\/hub\/worldview(?:\/([^/]+))?\/?$/);
  if (hubMatch) {
    const projection = hubMatch[2] || WorldViewProjection.WORLD;
    if (!isWorldViewProjection(projection)) return null;
    const target = `${hubMatch[1]}/hub/worldview/${projection}${canonicalSearch(search, undefined, false)}`;
    return target === `${pathname}${search}` ? null : target;
  }

  const localMatch = pathname.match(/^(.*\/(?:dock|dev|win))\/worldview(?:\/(.*?))?\/?$/);
  if (!localMatch) return null;
  const rest = (localMatch[2] ?? '').split('/').filter(Boolean);

  let projection = WorldViewProjection.DEPLOYMENT;
  let focus: string | undefined;
  if (rest.length === 1 && isWorldViewProjection(rest[0])) {
    projection = rest[0];
  } else if (rest.length === 2) {
    // Legacy `/worldview/<entity-type>/<uuid>` links become a deployment
    // projection with their entity identity carried as shareable focus state.
    focus = `${decodeURIComponent(rest[0])}-${decodeURIComponent(rest[1])}`;
  } else if (rest.length > 0) {
    return null;
  }

  const target = `${localMatch[1]}/worldview/${projection}${canonicalSearch(search, focus)}`;
  return target === `${pathname}${search}` ? null : target;
}
