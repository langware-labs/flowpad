/// <reference types="vite/client" />

// Vite-time defines from vite.config.ts.
declare const __API_URL__: string;

// Lingui `.po` catalogs are compiled to runtime messages by @lingui/vite-plugin
// on import (see vite.config.ts). Typed here so dynamic imports of
// `../locales/<locale>/messages.po` resolve.
declare module '*.po' {
  import type { Messages } from '@lingui/core';
  export const messages: Messages;
}
