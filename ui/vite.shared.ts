import fs from 'fs';
import path from 'path';

/**
 * Resolution shared by the app build (`vite.config.ts`) and the SDK library
 * build (`vite.sdk.config.ts`).
 *
 * Both bundle the same ts_sdk sources, so both need the same answer to "which
 * copy of axios/react/zustand is THE copy". Kept in one place because a fix for
 * a duplicate-instance bug applied to only one of the two configs would look
 * fixed while still shipping broken from the other.
 */

/** Packages that must resolve to a single instance across the bundle. */
export const SHARED_DEDUPE = [
  'react',
  'react-dom',
  'react-router',
  '@tanstack/react-query',
  'zustand',
  'axios',
  'mobx',
  'immer',
  '@msgpack/msgpack',
  'uuid',
  'events',
  'eventsource-parser',
  'http-status-codes',
  'cytoscape',
  'best-effort-json-parser',
  'mobx-utils',
  'yaml',
];

/** The flow_sdk release this bundle was built from, for `__UI_VERSION__`.
 *
 *  Not `package.json`'s version — that is an unmaintained `0.0.1` placeholder.
 *  Read from source rather than taken from the backend because the frontend is
 *  deployed independently of it: the hub reports ITS version, not the UI's.
 *  Empty string rather than a build failure if the file ever moves. */
export function sdkVersion(repoRoot: string): string {
  try {
    const src = fs.readFileSync(path.resolve(repoRoot, 'flow_sdk/_version.py'), 'utf-8');
    return /__version__\s*=\s*["']([^"']+)["']/.exec(src)?.[1] ?? '';
  } catch {
    return '';
  }
}

/** `@sdk` / `@src` — the two path aliases both builds resolve. */
export function sharedAliases(uiDir: string) {
  return {
    '@src': path.resolve(uiDir, './src'),
    '@sdk': path.resolve(uiDir, '../ts_sdk/src'),
  };
}
