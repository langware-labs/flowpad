import { hubModeReady, isHubOnly } from '@sdk';
const GOOGLE_TAG_MANAGER_ID = 'GTM-WHLSBH6Q';
const GTM_SCRIPT_URL = 'https://www.googletagmanager.com/gtm.js';

/**
 * Measure analytics on hub UI only and not on vite dev server.
 */
export function measured(): boolean {
  return isHubOnly() && !import.meta.env.DEV;
}

/**
 * Inject the GTM container, once per page.
 *
 * No gate of its own: the page-wide call below decides whether this page is measured.
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

// Load Google Tag Manager page-wide on the hub. Hub mode is unknown until bootstrap answers.
void hubModeReady().then(() => {
  if (measured()) injectGoogleTagManager();
});
