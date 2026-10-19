import { config } from '@sdk';
const GOOGLE_TAG_MANAGER_ID = 'GTM-WHLSBH6Q';
const GTM_SCRIPT_URL = 'https://www.googletagmanager.com/gtm.js';

/**
 * Inject the GTM container, once per page.
 *
 * No environment gate of its own: the caller decides whether this page is measured.
 * The page-wide call below measures PRODUCTION builds; the hub's `/launch` page opts
 * in on its own (`launch-analytics.ts`), because the hub serves the desktop build.
 * The DOM check, not a module flag, is the guard — this module is also a separate
 * `index.html` entry, and a second copy of it must not load the container twice.
 */
export function injectGoogleTagManager(): void {
  window.dataLayer = window.dataLayer || [];
  if (document.querySelector(`script[src^="${GTM_SCRIPT_URL}"]`)) return;

  window.dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
  const script = document.createElement('script');
  script.async = true;
  script.src = `${GTM_SCRIPT_URL}?id=${GOOGLE_TAG_MANAGER_ID}`;
  const first = document.getElementsByTagName('script')[0];
  if (first?.parentNode) first.parentNode.insertBefore(script, first);
  else document.head.appendChild(script);
}

// Only load Google Tag Manager page-wide in the production environment.
if (config.DEPLOY_ENV === 'PRODUCTION') injectGoogleTagManager();
