import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { getIconPacks, resolveIcon } from '@sdk/icons';
import { dataManager } from '@sdk';
import { lucideByName } from '@src/lib/lucide-by-name';

const cache = new Map<string, string>();

/**
 * A URL the graph canvas can draw for an entity type.
 *
 * Sigma's `NodePictogramProgram` takes an image URL, and the two icon
 * strategies answer that differently:
 *
 *  - a **bundle** glyph has no file of its own — the geometry lives in the
 *    renderer — so it is rendered to SVG markup here and inlined as a data URI,
 *    which is what this always did;
 *  - an **asset** glyph already IS a file the backend serves, so its URL is the
 *    answer directly. Rendering it would produce a masked `<span>`, which draws
 *    nothing on a canvas.
 *
 * `renderToStaticMarkup` stays app-side on purpose: it is `react-dom/server`,
 * which the SDK neither has nor should.
 */
export function iconDataUriForType(type: string): string {
  const cached = cache.get(type);
  if (cached) return cached;

  const name = dataManager?.iconForType?.(type);
  const res = resolveIcon(name, getIconPacks());

  // A served file is already a URL the canvas can load.
  if (res.kind === 'asset' || res.kind === 'path') {
    cache.set(type, res.url);
    return res.url;
  }

  const Icon = lucideByName(name);
  const svgMarkup = renderToStaticMarkup(
    createElement(Icon, {
      size: 64,
      color: '#ffffff',
      strokeWidth: 2.2,
    }),
  );

  const dataUri = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svgMarkup)))}`;
  cache.set(type, dataUri);
  return dataUri;
}

export function clearIconCache(): void {
  cache.clear();
}
