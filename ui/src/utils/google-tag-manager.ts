import { hubModeReady, isHubOnly } from '@sdk';
import { HUB_HOME_PATH } from '@src/lib/hub-page-url';

const GOOGLE_TAG_MANAGER_ID = 'GTM-WHLSBH6Q';
const GTM_SCRIPT_URL = 'https://www.googletagmanager.com/gtm.js';

/**
 * The only paths GTM may load on. An allowlist because its tags report the full URL, and other
 * routes carry secrets in theirs (`/invite/:token`). `/launch` is the launch funnel's own page.
 */
const MEASURED_PATHS = new Set<string>([HUB_HOME_PATH, '/launch']);

/** Measure analytics on the hub UI only, on allowed paths, and never on the vite dev server. */
export function measured(pathname: string): boolean {
  return isHubOnly() && !import.meta.env.DEV && MEASURED_PATHS.has(pathname);
}

/** Inject the GTM container, once per page: this runs on every navigation. */
function injectGoogleTagManager(): void {
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

/** Load GTM if `pathname` is measured. Hub mode is unknown until bootstrap answers. */
export function loadGoogleTagManager(pathname: string): void {
  void hubModeReady().then(() => {
    if (measured(pathname)) injectGoogleTagManager();
  });
}
