import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { iconForType } from './iconRegistry';

const cache = new Map<string, string>();

export function iconDataUriForType(type: string): string {
  const cached = cache.get(type);
  if (cached) return cached;

  const Icon = iconForType(type);
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
