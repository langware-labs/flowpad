import { sdkConfig } from '../config/index';

/**
 * An icon string is either a NAME or a FILE. This module is the one place that
 * decides which, and turns the file case into something the browser can load.
 *
 * `TypeInfo.icon`, `EnvVarSpec.icon` and the stored icon fields all carry a
 * single free string. Three shapes are in use:
 *
 *  - a lucide export name — `"BrainCog"`, `"Github"`
 *  - an absolute URL or data URI — passed through untouched
 *  - a path to a file the BACKEND serves — `"icons/agent.svg"`,
 *    `"/static/icons/agent.svg"` — absolutised against the API origin here
 *
 * The discriminator is "contains a slash". A lucide export name is a bare
 * PascalCase word and can never contain one, so the test needs no registry
 * lookup and no guessing from punctuation (a name may contain digits; a path
 * may lack an extension).
 *
 * Absolutised HERE, in the SDK, because the API base is the SDK's to know — no
 * app-level component may build a backend URL (CLAUDE.md). Built from
 * `sdkConfig.apiUrl`, the bare origin — NOT `SERVER_URL`, which appends the
 * `/api/v1` prefix these static files do not live under.
 */

/** True when the icon string names a FILE rather than a lucide export. */
export function isIconPath(icon?: string | null): boolean {
  return !!icon && icon.includes('/');
}

/**
 * A loadable URL for a file-shaped icon, or `undefined` for a lucide name (and
 * for a path that cannot be resolved). Callers render the name case themselves
 * — `undefined` means "not a file", not "broken".
 *
 * `base` prefixes a relative path when the file lives under a subtree of the
 * backend's static root rather than at it, e.g. a hub plugin's own folder.
 */
export function iconAssetUrl(icon?: string | null, base?: string): string | undefined {
  if (!icon) return undefined;
  if (/^(https?:)?\/\//.test(icon) || icon.startsWith('data:')) return icon;
  if (!isIconPath(icon)) return undefined;
  const path = icon.replace(/^\//, '');
  const prefix = base ? `${base.replace(/^\/|\/$/g, '')}/` : '';
  return `${sdkConfig.apiUrl}/${prefix}${path}`;
}
