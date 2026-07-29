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

/** `@sdk` / `@src` — the two path aliases both builds resolve. */
export function sharedAliases(uiDir: string) {
  return {
    '@src': path.resolve(uiDir, './src'),
    '@sdk': path.resolve(uiDir, '../ts_sdk/src'),
  };
}
