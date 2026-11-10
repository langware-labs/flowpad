import { hubModeReady, isHubOnly } from '@sdk';
import { HUB_HOME_PATH } from '@src/lib/hub-page-url';
import { parseLaunchParams } from '@src/pages/entry/launch-target';

const GOOGLE_TAG_MANAGER_ID = 'GTM-WHLSBH6Q';
const GTM_SCRIPT_URL = 'https://www.googletagmanager.com/gtm.js';

/**
 * Whether GTM may load on this page: hub UI only, never on the vite dev server, and only on an
 * allowlist. Its tags send the full URL and the referrer, and other pages carry secrets there:
 * `/invite/:token`, a private repository in `/launch?repo=`.
 */
export function measured(pathname: string, search: string): boolean {
  if (!isHubOnly() || import.meta.env.DEV) return false;
  if (pathname === HUB_HOME_PATH) return true;
  if (pathname !== '/launch') return false;
  // The agent and project launch page, the only `/launch` page that loaded GTM before this list.
  const { kind } = parseLaunchParams(new URLSearchParams(search));
  return kind === 'agent' || kind === 'project';
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

/** Load GTM if this page is measured. Hub mode is unknown until bootstrap answers. */
export function loadGoogleTagManager(pathname: string, search: string): void {
  void hubModeReady().then(() => {
    if (measured(pathname, search)) injectGoogleTagManager();
  });
}
