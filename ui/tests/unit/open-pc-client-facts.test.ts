import { describe, expect, it } from 'vitest';

import { browserOf, clientFacts, inAppBrowser, osOf } from '@src/pages/entry/client-facts';

// The two phones from the 2026-11-11 "Forbidden" report, as the hub's load balancer saw them.
const STUDENT_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 27_2_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/157.0.8103.37 Mobile/15E148 Safari/604.1';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36';
const INSTAGRAM_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0';
const IOS_APP_WEBVIEW =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const ANDROID_WEBVIEW =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0 Mobile Safari/537.36';

describe('open-pc client facts', () => {
  it('names the student phone: Chrome on iOS 27.2, a real browser', () => {
    expect(osOf(STUDENT_IPHONE)).toBe('iOS 27.2');
    expect(browserOf(STUDENT_IPHONE)).toBe('Chrome iOS 157');
    expect(inAppBrowser(STUDENT_IPHONE)).toBe('no');
  });

  it('names Android Chrome', () => {
    expect(osOf(ANDROID_CHROME)).toBe('Android 10');
    expect(browserOf(ANDROID_CHROME)).toBe('Chrome 156');
    expect(inAppBrowser(ANDROID_CHROME)).toBe('no');
  });

  it("tells an app's built-in browser apart", () => {
    expect(inAppBrowser(INSTAGRAM_IOS)).toBe('instagram');
    expect(inAppBrowser(IOS_APP_WEBVIEW)).toBe('ios-webview');
    expect(inAppBrowser(ANDROID_WEBVIEW)).toBe('android-webview');
  });

  it('reports only the fields the hub keeps, as short strings', () => {
    const facts = clientFacts();
    expect(Object.keys(facts).sort()).toEqual(['browser', 'cookies', 'in_app', 'lang', 'os', 'page_ms', 'standalone']);
    for (const value of Object.values(facts)) expect(typeof value).toBe('string');
    expect(['yes', 'no']).toContain(facts.cookies);
  });
});
