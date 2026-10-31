/**
 * A previewed page's share menu (WhatsApp, a Gmail or Outlook draft, the mail app) asks the
 * host to open the link, because the sandboxed preview frame cannot: WhatsApp and Gmail refuse
 * a window it opens (`ERR_BLOCKED_BY_RESPONSE`), and it may not hand a mailto: to the mail app.
 * The host opens only this closed list; that it answers only its own frame is pinned with the
 * frame in `html-preview-served-url.test.tsx`.
 */
import { describe, expect, it } from 'vitest';
import { previewShareUrl } from '@src/components/html-preview/share-links';

const ask = (url: string) => ({ type: 'flowpad:open-external', url });

describe('previewShareUrl', () => {
  it('opens WhatsApp, Gmail and Outlook share links, and a mailto: draft', () => {
    for (const url of [
      'https://wa.me/?text=hi%20https%3A%2F%2Fgames.example%2F',
      'https://api.whatsapp.com/send/?text=hi',
      'https://web.whatsapp.com/send?text=hi',
      'https://mail.google.com/mail/?view=cm&fs=1&su=Game&body=hi',
      'https://outlook.office.com/mail/deeplink/compose?subject=Game&body=hi',
      'https://outlook.live.com/mail/0/deeplink/compose?subject=Game&body=hi',
      'mailto:?subject=Game&body=hi',
    ]) {
      expect(previewShareUrl(ask(url))).toBe(new URL(url).href);
    }
  });

  it('refuses every other address', () => {
    for (const url of [
      'https://example.com/',
      'https://wa.me.evil.example/',
      'https://evil.example/?u=https://wa.me/',
      'http://wa.me/?text=hi',
      'https://user:pw@wa.me/',
      'tel:+972500000000',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'not a url',
    ]) {
      expect(previewShareUrl(ask(url))).toBeNull();
    }
  });

  it('answers only the open-external message', () => {
    expect(previewShareUrl({ type: 'flowpad:navigate', url: 'https://wa.me/' })).toBeNull();
    expect(previewShareUrl(null)).toBeNull();
    expect(previewShareUrl({ type: 'flowpad:open-external', url: 42 })).toBeNull();
  });
});
