import { config } from '@sdk';
const GOOGLE_TAG_MANAGER_ID = 'GTM-WHLSBH6Q';

function loadGoogleTagManager(): void {
  window.dataLayer = window.dataLayer || [];

  // Only load Google Tag Manager in production environment
  if (config.DEPLOY_ENV !== 'PRODUCTION') {
    return;
  }

  (function (w, d, s, l, i) {
    const windowWithDataLayer = w as unknown as Record<string, unknown>;
    windowWithDataLayer[l] = (windowWithDataLayer[l] as Array<Record<string, unknown>>) || [];
    (windowWithDataLayer[l] as Array<Record<string, unknown>>).push({
      'gtm.start': new Date().getTime(),
      event: 'gtm.js',
    });
    const f = d.getElementsByTagName(s)[0];
    const j = d.createElement(s) as HTMLScriptElement;
    const dl = l != 'dataLayer' ? '&l=' + l : '';
    j.async = true;
    j.src = 'https://www.googletagmanager.com/gtm.js?id=' + i + dl;
    if (f.parentNode) {
      f.parentNode.insertBefore(j, f);
    }
  })(window, document, 'script', 'dataLayer', GOOGLE_TAG_MANAGER_ID);
}

loadGoogleTagManager();
