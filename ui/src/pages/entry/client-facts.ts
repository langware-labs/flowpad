/**
 * What the open-pc page says about the phone it runs on, sent with `visitor-sandbox` so the hub logs it next to
 * the ticket it hands out (`visitor-open: … client=[…]`). Only diagnosis: the hub never decides anything on it.
 *
 * Read before the redirect, because after it the page is gone: whether this browser accepts cookies at all,
 * whether it is an app's built-in browser (where cookie rules differ), and how long the page took.
 */

export interface ClientFacts {
  cookies: string;
  in_app: string;
  os: string;
  browser: string;
  standalone: string;
  lang: string;
  page_ms: string;
}

const IN_APP: [RegExp, string][] = [
  [/Instagram/i, 'instagram'],
  [/FBAN|FBAV|FB_IAB/i, 'facebook'],
  [/WhatsApp/i, 'whatsapp'],
  [/\bLine\//i, 'line'],
  [/; wv\)/i, 'android-webview'],
];

const BROWSERS: [RegExp, string][] = [
  [/CriOS\/(\d+)/, 'Chrome iOS'],
  [/FxiOS\/(\d+)/, 'Firefox iOS'],
  [/EdgiOS\/(\d+)/, 'Edge iOS'],
  [/Edg\/(\d+)/, 'Edge'],
  [/SamsungBrowser\/(\d+)/, 'Samsung Internet'],
  [/Firefox\/(\d+)/, 'Firefox'],
  [/Chrome\/(\d+)/, 'Chrome'],
  [/Version\/(\d+)[\d.]* .*Safari\//, 'Safari'],
];

export function inAppBrowser(ua: string): string {
  for (const [pattern, name] of IN_APP) if (pattern.test(ua)) return name;
  // An iOS app's WKWebView reports the device but no browser token at all.
  if (/iPhone|iPad/.test(ua) && !/Safari\//.test(ua)) return 'ios-webview';
  return 'no';
}

export function osOf(ua: string): string {
  const ios = ua.match(/(?:iPhone|iPad); CPU (?:iPhone )?OS (\d+)_(\d+)/);
  if (ios) return `iOS ${ios[1]}.${ios[2]}`;
  const android = ua.match(/Android (\d+)/);
  if (android) return `Android ${android[1]}`;
  if (/Mac OS X/.test(ua)) return 'macOS';
  if (/Windows/.test(ua)) return 'Windows';
  return /Linux/.test(ua) ? 'Linux' : 'unknown';
}

export function browserOf(ua: string): string {
  for (const [pattern, name] of BROWSERS) {
    const m = ua.match(pattern);
    if (m) return `${name} ${m[1]}`;
  }
  return 'unknown';
}

export function clientFacts(): ClientFacts {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const standalone =
    (typeof navigator !== 'undefined' && (navigator as Navigator & { standalone?: boolean }).standalone) ||
    (typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches);
  return {
    cookies: typeof navigator !== 'undefined' && navigator.cookieEnabled ? 'yes' : 'no',
    in_app: inAppBrowser(ua),
    os: osOf(ua),
    browser: browserOf(ua),
    standalone: standalone ? 'yes' : 'no',
    lang: typeof navigator === 'undefined' ? '-' : navigator.language || '-',
    page_ms: String(Math.round(typeof performance === 'undefined' ? 0 : performance.now())),
  };
}
